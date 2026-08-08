#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
version="$(node -p 'JSON.parse(require("fs").readFileSync("manifest.json")).version')"
archive="dist/downloadswift-${version}.zip"

# One list for every package. Two hand-synced lists is how a browser build ends
# up silently missing a module that only that browser loads.
shared_files="icon.svg service-worker.mjs popup.html popup.css popup.js offscreen.js media.mjs hls.mjs dash.mjs mp4.mjs preview.mjs sites.mjs resolve.mjs i18n.mjs"
shared_dirs="_locales icons vendor"

mkdir -p dist
rm -f "$archive"
# Chrome and Edge add the service-worker manifest and the offscreen document.
# shellcheck disable=SC2086
zip -qr "$archive" manifest.json offscreen.html $shared_files $shared_dirs
unzip -tq "$archive"

# Firefox and Safari swap the service worker for a background page and take a
# generated manifest; everything else is the same source.
package_background_browser() {
  target="$1"
  target_dir="dist/$target"
  target_archive="dist/downloadswift-${target}-${version}.zip"
  rm -rf "$target_dir"
  rm -f "$target_archive"
  mkdir -p "$target_dir"
  # shellcheck disable=SC2086
  cp background.html background.mjs $shared_files "$target_dir"
  # shellcheck disable=SC2086
  cp -R $shared_dirs "$target_dir"
  node scripts/browser-manifest.mjs "$target" manifest.json "$target_dir/manifest.json"
  (cd "$target_dir" && zip -qr "../downloadswift-${target}-${version}.zip" .)
  unzip -tq "$target_archive"
  echo "$target_archive"
}

echo "$archive"
package_background_browser firefox
package_background_browser safari
