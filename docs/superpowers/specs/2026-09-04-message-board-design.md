# Message board (guestbook) — design

Date: 2026-09-04

## Goal

Add a small, flat guestbook-style message board embedded on the homepage:
visitors post a name (optional), an optional link to their own site, and a
message, into one shared reverse-chronological feed. No threading, no
accounts, no admin UI. This is the site's first server-side functionality —
everything else is prebuilt static HTML served by Zola.

## Background

The site (`ericstate.space`) is a Zola static site with no backend today.
It will be deployed on Cloudflare Pages, using free-tier features only:
Pages (static hosting + Functions), D1 (SQL storage), Turnstile (bot
challenge), and the account's one free WAF rate-limiting rule.

Relevant existing conventions this design follows rather than reinvents:

- The homepage (`templates/index.html`) is a "bento box" of cells, each a
  `.bento-cell` with a `.bento-titlebar` and a `.bento-content` div (see
  `#bento-blog`, `#bento-curios`, `#bento-links`). The guestbook becomes one
  more cell in this same grid.
- All client-side interactivity is plain, framework-free JS files under
  `static/js/` (`marquee.js`, `toc-scrollspy.js`, `link-popups.js`, etc.),
  loaded via `{% block scripts %}` at the bottom of a template. No bundler,
  no framework — the guestbook's JS follows the same pattern.
- `zola.toml`'s `[markdown]` section already sets
  `external_links_no_follow`/`external_links_no_referrer` for links inside
  page content. The guestbook's user-submitted links get the equivalent
  treatment by hand, since they're rendered by JS rather than Zola's
  Markdown pipeline.
- The project has no git repository yet (confirmed: `git status` fails all
  the way up to `$HOME`). Out of scope for this spec — noted so it isn't
  mistaken for an oversight.

Cloudflare-specific facts this design relies on, confirmed against current
docs rather than assumed:

- Pages Functions' `functions/` directory must live at the **project
  root** — not inside the build output directory (`public/`, Zola's
  default) — for Cloudflare to pick it up. Zola's own build step is
  otherwise unaffected.
- `wrangler.toml`'s `account_id` and D1's `database_id` are not secrets —
  they're identifiers, meaningless without a valid API token, and
  Cloudflare's own guidance says they're fine in a public repo. The only
  value in this feature that must never be committed is the Turnstile
  **secret key** (server-side verification secret; the public sitekey is
  meant to be embedded in HTML and is not sensitive).
- The Workers/Pages Functions free tier: 100,000 requests/day, 10ms CPU
  time/request. D1 free tier: 5GB storage, 5M row reads/day, 100,000 row
  writes/day. The account's Free plan includes exactly one WAF rate
  limiting rule (IP-counted, Block action, 10s/1hr duration, 10s/1min
  window — these specific parameter choices are fixed on Free, not
  configurable).

## Design

### A. Data model (D1)

One table, no threading, no soft-delete (moderation is a hard `DELETE` run
by hand via `wrangler d1 execute`, not an in-app feature):

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT 'anonymous',
  url TEXT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL  -- unix timestamp, set server-side
);
```

- `name`: optional client-side (empty submissions stored as `'anonymous'`),
  length-capped (60 chars).
- `url`: optional. Server-side validation requires it start with `http://`
  or `https://` and stay under 300 chars; anything else is rejected
  outright rather than silently dropped, so the poster knows to fix it.
- `message`: required, 500 char cap, enforced by both the form's
  `maxlength` and a server-side re-check (never trust the client).
- `created_at`: set by the Function at insert time, not accepted from the
  client.

Migration file: `migrations/0001_create_messages.sql`, applied via
`wrangler d1 migrations apply <db-name>`.

### B. API (Pages Functions)

`functions/api/messages.js`, exporting:

- `onRequestGet` — returns the most recent 20 messages, newest-first, as
  JSON (`id`, `name`, `url`, `message`, `created_at`). No pagination in
  v1: older messages remain in D1 forever but simply scroll out of the
  homepage's view. Revisit only if this actually becomes a complaint.
- `onRequestPost` — in order: (1) reject if `message` is empty or over
  500 chars, or `name`/`url` exceed their caps, or `url` is present but
  malformed; (2) run the blocklist check (below) against `message`;
  (3) verify the submitted Turnstile token against Cloudflare's
  `siteverify` endpoint, using `TURNSTILE_SECRET_KEY` from the
  environment; (4) insert the row via the `DB` binding; (5) return the
  new row as JSON so the client can render it immediately without a
  second round-trip.

D1 binding (`DB`) and the `TURNSTILE_SECRET_KEY` binding are both declared
in `wrangler.toml` / the Pages project's environment variables — the
database binding as a plain `[[d1_databases]]` entry (safe to commit, see
Background), the Turnstile secret as an **encrypted** Pages environment
variable (never committed) plus a matching entry in a local `.dev.vars`
file for `wrangler pages dev` testing.

### C. Abuse prevention

Three independent layers, matching what was already agreed on before this
spec, formalized here against the real endpoint:

- **Content blocklist**: a plain array of banned substrings/patterns
  living in `functions/api/messages.js`, checked case-insensitively
  against `message` before any Turnstile or D1 call. A match short-circuits
  with a 400 — cheapest check runs first.
- **Turnstile**: a Managed widget embedded in the guestbook's form (public
  sitekey, hardcoded in the HTML — not sensitive). `onRequestPost` rejects
  the request if the token is missing or `siteverify` reports it invalid.
- **Rate limiting**: the account's one free WAF rate limiting rule,
  scoped to `POST /api/messages` specifically (the site's only mutable
  endpoint — the obvious, and only, candidate for the single rule this
  account gets), IP-counted, blocking after a small burst (e.g. 5
  requests / 10 seconds).

### D. Front-end integration

New cell in `templates/index.html`, `#bento-guestbook`, placed after
`#bento-links` inside `#bento-box`, structurally identical to the existing
cells (`.bento-titlebar` + `.bento-content`). Contains a form (name field,
url field, message textarea, Turnstile widget, submit button) above the
rendered message list.

New `static/js/guestbook.js`, loaded via `{% block scripts %}` in
`templates/index.html` alongside the existing `marquee.js`/
`bento-links-fit.js`:

- On load: `fetch('/api/messages')`, render each message into the list —
  `name` becomes `<a href="{url}" target="_blank" rel="nofollow noopener
  noreferrer">{name}</a>` when `url` is present, plain text otherwise.
- On form `submit`: `event.preventDefault()`, `fetch()` the `POST` with
  the form's fields plus the Turnstile response token, then prepend the
  returned row to the rendered list on success, or show the server's error
  message inline on failure (blocklist rejection, invalid URL, failed
  Turnstile, rate-limited).

Because the homepage is pre-rendered by Zola at deploy time, the message
list cannot be baked into the static HTML — it is always populated
client-side after load, same as the rest of the site's JS-driven behavior.
No-JS visitors see the empty cell and the form but not the existing
messages; acceptable for a "very small" feature and consistent with the
site not offering a no-JS fallback for its other interactive pieces
(marquee, lightbox, TOC scrollspy).

### E. File layout and deploy config

New files, all at the repo root unless noted:

- `functions/api/messages.js` — the Function (Section B).
- `wrangler.toml` — Pages project config: `[[d1_databases]]` binding
  (`binding = "DB"`), `database_id`, `database_name`. Safe to commit
  (Background).
- `migrations/0001_create_messages.sql` — the schema (Section A).
- `.dev.vars` — local-only, holds `TURNSTILE_SECRET_KEY` for `wrangler
  pages dev`. **Added to `.gitignore`**, never committed.
- `static/js/guestbook.js` — the client-side behavior (Section D).

Zola's own build (`zola build` → `public/`) is untouched. Cloudflare Pages
is configured with build command `zola build`, output directory `public`,
and picks up `functions/` from the repo root automatically per Cloudflare's
documented behavior — no additional build configuration needed.

## Out of scope

- Any other site feature discussed alongside this one previously (RSS
  feed, etc.) — this spec covers the message board only.
- Threading/replies.
- Pagination or an "older messages" view beyond the most recent 20.
- An in-app admin/moderation UI — moderation is `wrangler d1 execute
  ... DELETE FROM messages WHERE id = ?`, run by hand.
- Editing or deleting your own post after submission.
- Rich text / Markdown in messages — plain text only, rendered escaped.
- Initializing git for this repository.

## Testing

- `wrangler d1 migrations apply` succeeds locally against a test D1
  database; schema matches Section A.
- `wrangler pages dev` locally: posting a message with just a message
  (no name/url) stores `'anonymous'` and a `NULL` url; posting with all
  three fields round-trips correctly; a message over 500 chars is
  rejected; a malformed `url` (missing scheme) is rejected with a clear
  error rather than silently dropped.
- Blocklist: a message containing a blocklisted term is rejected before
  any D1 write (verify via D1 row count unchanged).
- Turnstile: a request with a missing/invalid token is rejected by
  `onRequestPost` before insert.
- Rate limit: scripted rapid POSTs from one IP past the configured
  threshold return the block response; a normal single post from a fresh
  IP succeeds.
- Front-end: fresh homepage load renders the most recent messages;
  submitting via the form prepends the new message without a full page
  reload; a link-bearing message renders as an `<a>` with
  `rel="nofollow noopener noreferrer"` and opens in a new tab.
- Confirm `.dev.vars` is git-ignored and `TURNSTILE_SECRET_KEY` is not
  present anywhere in `wrangler.toml` or any committed file.
