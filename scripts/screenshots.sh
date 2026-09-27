#!/usr/bin/env bash
# Capture real README screenshots from the running extension into
# docs/screenshots/, then turn the recorded touchdown replay into a GIF.
# The popup opens on screen for about 20 seconds while this runs.
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
uuid=nfl-scores@shanekanterman
schema_dir="$HOME/.local/share/gnome-shell/extensions/$uuid/schemas"
out="$repo_dir/docs/screenshots"
key=(gsettings --schemadir "$schema_dir" set org.gnome.shell.extensions.nfl-scores screenshot-dir)
get=(gsettings --schemadir "$schema_dir" get org.gnome.shell.extensions.nfl-scores screenshot-dir)

mkdir -p "$out"
rm -rf "$out/.frames" "$out/error.txt"
"${key[@]}" "$out"
echo "Capturing… (the popup will open by itself; don't type for ~30 seconds)"

for _ in {1..120}; do
    [[ $("${get[@]}") == "''" ]] && break
    sleep 0.5
done
if [[ $("${get[@]}") != "''" ]]; then
    "${key[@]}" ''
    echo "Timed out waiting for the extension. Is it enabled and reloaded (make reload)?" >&2
    exit 1
fi
if [[ -f $out/error.txt ]]; then
    cat "$out/error.txt" >&2
    exit 1
fi

if [[ -f $out/.frames/frames.txt ]]; then
    # Two-pass palette GIF at 30 fps, keeping the frames' real timing.
    ffmpeg -loglevel error -y -f concat -safe 0 -i "$out/.frames/frames.txt" \
        -vf "fps=30,scale=iw:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a" \
        "$out/touchdown.gif"
    rm -rf "$out/.frames"
fi

ls -lh "$out"
