#!/usr/bin/env python3
"""
Scans content/ for wikipedia.org/wiki/ links and caches their summaries.

Writes static/wikipedia_cache.json keyed by the exact URL found in content,
so the client-side popup script can look entries up by href with no
normalization needed. Never touches entries that already exist unless
--refresh is passed.
"""

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT_DIR = ROOT / "content"
CACHE_PATH = ROOT / "static" / "wikipedia_cache.json"

LINK_RE = re.compile(
    r"https?://(?:[a-z-]+\.)?wikipedia\.org/wiki/[^\s)\"'>\]]+"
)
EXTRACT_MAX_CHARS = 280
USER_AGENT = "eric-ss-migration-wikipedia-cache/1.0 (build-time link preview fetcher)"


def find_links():
    links = set()
    for path in CONTENT_DIR.rglob("*.md"):
        text = path.read_text(encoding="utf-8")
        for match in LINK_RE.findall(text):
            links.add(match.rstrip(".,;:"))
    return sorted(links)


def title_from_url(url):
    path = urllib.parse.urlparse(url).path
    slug = path.split("/wiki/", 1)[1]
    slug = slug.split("#", 1)[0]
    return urllib.parse.unquote(slug).replace("_", " ")


def truncate_extract(text):
    text = text.strip()
    if len(text) <= EXTRACT_MAX_CHARS:
        return text
    truncated = text[:EXTRACT_MAX_CHARS]
    last_period = truncated.rfind(". ")
    if last_period > EXTRACT_MAX_CHARS * 0.4:
        return truncated[: last_period + 1]
    last_space = truncated.rfind(" ")
    if last_space > 0:
        truncated = truncated[:last_space]
    return truncated.rstrip() + "…"


def fetch_summary(url):
    title = title_from_url(url)
    slug = urllib.parse.quote(title.replace(" ", "_"))
    api_url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{slug}"
    req = urllib.request.Request(api_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.load(resp)

    if data.get("type") == "disambiguation":
        raise ValueError(f"{title!r} is a disambiguation page, skipping")

    thumbnail = data.get("thumbnail", {}).get("source")
    page_url = data.get("content_urls", {}).get("desktop", {}).get("page", url)

    return {
        "title": data.get("title", title),
        "extract": truncate_extract(data.get("extract", "")),
        "thumbnail": thumbnail,
        "page_url": page_url,
    }


def load_cache():
    if not CACHE_PATH.exists():
        return {}
    return json.loads(CACHE_PATH.read_text(encoding="utf-8"))


def save_cache(cache):
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(
        json.dumps(cache, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="re-fetch every link, even ones already cached",
    )
    args = parser.parse_args()

    links = find_links()
    if not links:
        print("No wikipedia.org links found in content/.")
        return

    cache = load_cache()
    to_fetch = links if args.refresh else [u for u in links if u not in cache]

    fetched, skipped, unchanged = 0, 0, len(links) - len(to_fetch)

    for url in to_fetch:
        try:
            cache[url] = fetch_summary(url)
            fetched += 1
            print(f"  fetched: {url}")
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, KeyError) as e:
            skipped += 1
            print(f"  SKIPPED: {url} ({e})", file=sys.stderr)

    # Drop cache entries for links no longer present in content.
    stale = [u for u in cache if u not in links]
    for url in stale:
        del cache[url]

    save_cache(cache)
    print(
        f"Done: {fetched} fetched, {skipped} skipped, {unchanged} unchanged, "
        f"{len(stale)} stale entries removed. Cache: {CACHE_PATH.relative_to(ROOT)}"
    )


if __name__ == "__main__":
    main()
