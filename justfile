# Fetch summaries for any new Wikipedia links found in content/.
wiki-cache:
    python3 scripts/fetch_wikipedia_cache.py

# Re-fetch every cached Wikipedia link, even ones already cached.
wiki-cache-refresh:
    python3 scripts/fetch_wikipedia_cache.py --refresh

# Vendor a fresh Lenia build (run `wasm-pack build --target web` in ../lenia first)
# into static/lenia/, keeping the curio's asset paths intact.
sync-lenia lenia_dir="../lenia":
    #!/usr/bin/env bash
    set -euo pipefail
    src="{{lenia_dir}}"
    dest="static/lenia"
    if [ ! -d "$src/pkg" ]; then
        echo "error: $src/pkg not found — run 'wasm-pack build --target web' in $src first" >&2
        exit 1
    fi
    mkdir -p "$dest"
    cp -r "$src/www/." "$dest/"
    rm -rf "$dest/index.html" "$dest/pkg-node-simd" "$dest/pkg-node-nosimd"
    mkdir -p "$dest/pkg"
    cp -r "$src/pkg/." "$dest/pkg/"
    sed -i "s|from '\.\./pkg/lenia_rs\.js'|from './pkg/lenia_rs.js'|" "$dest/main.js"
    echo "synced $src/www + $src/pkg -> $dest"
