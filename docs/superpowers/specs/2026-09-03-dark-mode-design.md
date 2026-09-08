# Dark mode toggle — design

Date: 2026-09-03

## Goal

Add a three-way (auto / light / dark) theme toggle to the site, as a floating
sticky control in the top-right corner, with minimal change to the existing
codebase. Not present on `/lenia/`, the `fred` curio, or the `supertask`
curio.

## Background

Colors currently live as a handful of Sass variables (`sass/_colors.scss`)
and hardcoded hex/`rgba()` literals inside `sass/global.scss` (~30
occurrences across ~6 distinct colors). There is no existing CSS custom
property layer. SVG icons throughout the site already use `currentColor` for
their strokes/fills, so they need no change.

`fred.html`, `curios/lenia.html`, and `curios/supertask.html` are standalone
HTML documents that do not `{% extends "base.html" %}` — they render outside
the shared chrome entirely. This means excluding them from the toggle
requires no special-casing: anything added only to `base.html` is
automatically absent from those three pages.

Code blocks are highlighted at build time by Zola (0.23.4, which bundles
[Giallo](https://github.com/getzola/giallo)) using a single theme
(`snazzy-light`) baked into inline `style="color:…"` attributes on each
token span. Giallo supports dual light/dark themes with class-based output
instead, confirmed against the current Zola docs and a real local build
(`light_theme`/`dark_theme`/`style = "class"` in
`[markdown.highlighting]` produces `giallo-light.css` and `giallo-dark.css`
in `public/`). `min-light` and `min-dark` are real built-in Giallo theme
names.

## Design

### A. Color tokens

Introduce CSS custom properties on `:root` in `sass/global.scss`, replacing
today's hardcoded colors:

- `--color-bg` (page background; currently implicit browser white)
- `--color-bg-rgb` (same color as an `R,G,B` triplet, for alpha blending)
- `--color-text` (was `#000` / `$text-color`)
- `--color-text-secondary` (was `#333333`)
- `--color-border` (was `#cccccc` / `#e6e6e6`)
- `--color-surface` (was `#f8f8f8`, e.g. code/inline chrome backgrounds)
- `--color-link-hover` (was `$link-hover-color`, `#00F`)

Dark values are redefined under `:root[data-theme="dark"]`.

Two spots need `--color-bg-rgb` instead of a flat color, because they blend
partial-alpha white into a fade:

- The marquee edge-fade gradients (`global.scss` ~589-654) — currently
  `rgba(255, 255, 255, X)` — become `rgba(var(--color-bg-rgb), X)`.
- The heading skip-ink trick (`$skip-ink-shadow`, ~991-997) — a stack of
  `text-shadow`s in the page's exact background color, used to fake
  underline-skipping under letter descenders — must track the real
  background or it'll show light boxes on a dark page.

`sass/_colors.scss`'s `$text-color`/`$link-hover-color` Sass variables are
replaced by the CSS custom properties above; the file is either trimmed to
just `$gray` (still used elsewhere) or removed if nothing else references
Sass-level color vars after the change.

### B. Theme resolution, persistence, no-flash

One `localStorage` key, `theme-mode`, holds `"auto" | "light" | "dark"`.
Absent (first visit) defaults to `"light"` — not system preference.

Two scripts, both added to `base.html`:

1. **Inline, in `<head>`, before the `global.css` `<link>`.** Synchronously
   reads `theme-mode` from `localStorage` (defaulting to `"light"`),
   resolves `"auto"` via
   `matchMedia("(prefers-color-scheme: dark)").matches`, and sets
   `data-theme="light"` or `data-theme="dark"` on `<html>` before any CSS
   paints. This is what prevents a flash of the wrong theme. It also sets
   the `disabled` property on the two Giallo `<link>` tags (see D) to match.
2. **Deferred, alongside the toggle button.** Owns the click handler:
   cycles `theme-mode` through `auto → light → dark → auto`, writes it to
   `localStorage`, recomputes the resolved theme, and updates
   `data-theme` + the two Giallo `<link>`s' `disabled` state. While the
   resolved mode is `"auto"`, it also listens for
   `matchMedia("(prefers-color-scheme: dark)")` `change` events and live
   updates the resolved theme without a reload.

`data-theme` on `<html>` is always a resolved `"light"`/`"dark"` — `"auto"`
only exists as the stored mode, never as a CSS-visible state. This keeps the
CSS side simple (one selector to redefine tokens under) with all the
auto-resolution logic living in JS.

### C. Toggle UI and placement

A single button, `position: fixed`, top-right corner, `z-index` above page
content, added to `base.html` via a new `templates/macros/theme_toggle.html`
(matching the existing macro-per-concern pattern in `templates/macros/`).
Clicking it cycles the three modes; an inline SVG icon (sun / moon /
half-circle, `currentColor`, following the same inline-`<symbol>` convention
already used for the nav logo and popup icons) and the button's
`aria-label`/`title` reflect the current mode.

Placed in `base.html` only — not in a way any of `fred.html`,
`curios/lenia.html`, or `curios/supertask.html` can pick up, since none of
those extend `base.html`.

### D. Code block theming

`zola.toml`:

```toml
[markdown.highlighting]
light_theme = "min-light"
dark_theme = "min-dark"
style = "class"
```

(replaces the current `theme = "snazzy-light"`).

This makes Zola emit `giallo-light.css` and `giallo-dark.css` into the site
root instead of inlining colors. `base.html` gets two `<link rel="stylesheet"
id="giallo-light" href="…giallo-light.css">` /
`id="giallo-dark" href="…giallo-dark.css">` tags. Rather than the docs'
suggested `media="(prefers-color-scheme: …)"` gating (which can't be
overridden from JS), both scripts from section B toggle `.disabled` on
whichever one doesn't match the resolved theme.

The two small CSS rules Giallo's docs require for correct layout
(`.giallo-l`, `.giallo-ln`) are added to `global.scss`.

## Out of scope

- Re-theming embedded images/SVGs in content (buddhabrot renders, Penrose
  diagrams, etc.) — left as-is.
- `fred.html`, `curios/lenia.html`, `curios/supertask.html` — explicitly
  excluded per the goal.
- Any change to `88x31_button_zoom.css` / `dummy.css` alternate stylesheets.

## Testing

- `zola build` succeeds; `giallo-light.css`/`giallo-dark.css` are generated.
- Manual check in a browser: toggle cycles all three modes, persists across
  reload, resolves `"auto"` correctly against OS light/dark, no flash of
  wrong theme on load (hard refresh in both OS modes).
- Spot-check pages with colored chrome: home, a blog post with a code
  block, `/curios/`, `/tags/` — confirm no leftover hardcoded colors show
  through in dark mode (especially the marquee fade and heading underlines).
- Confirm `/lenia/`, the `fred` curio, and the `supertask` curio render with
  no toggle button and are unaffected by `data-theme`.
