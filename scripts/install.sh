#!/usr/bin/env bash
# Install NFL Scores into the user's GNOME Shell and reload it in place.
# The first install needs one logout/login so GNOME Shell discovers it; after
# that, extension.js re-imports the changed modules on every reload.
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
uuid=nfl-scores@shanekanterman
dest="$HOME/.local/share/gnome-shell/extensions/$uuid"

for file in metadata.json extension.js scoreboard.js games.js field.js draw.js capture.js stylesheet.css \
        schemas/org.gnome.shell.extensions.nfl-scores.gschema.xml; do
    install -D -m 0644 "$repo_dir/$file" "$dest/$file"
done
glib-compile-schemas --strict "$dest/schemas"

if ! gnome-extensions info "$uuid" >/dev/null 2>&1; then
    gnome-extensions enable "$uuid" 2>/dev/null || true
    current=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ $current != *"'$uuid'"* ]]; then
        gsettings set org.gnome.shell enabled-extensions "${current%]}, '$uuid']"
    fi
    echo "Installed. Log out and back in once so GNOME Shell discovers NFL Scores."
    exit 0
fi

gnome-extensions disable "$uuid"
gnome-extensions enable "$uuid"

# enable() is async (it imports the modules), so wait for it to settle.
for _ in {1..20}; do
    state=$(gnome-extensions info "$uuid" | sed -n 's/^ *State: //p')
    [[ $state == ACTIVATING ]] || break
    sleep 0.15
done
echo "NFL Scores reloaded: ${state:-unknown}"
if [[ $state != ACTIVE ]]; then
    journalctl --user -b -o cat --since '-1 min' /usr/bin/gnome-shell |
        grep -i 'nfl' | tail -20 || true
fi
