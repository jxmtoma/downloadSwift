#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
version="$(node -p 'JSON.parse(require("fs").readFileSync("manifest.json")).version')"
archive="dist/downloadswift-${version}.zip"

mkdir -p dist
rm -f "$archive"
zip -qr "$archive" \
  manifest.json \
  icon.svg \
  service-worker.mjs \
  popup.html popup.css popup.js \
  offscreen.html offscreen.js \
  media.mjs hls.mjs i18n.mjs \
  _locales \
  icons \
  vendor/mux-mp4.min.js vendor/mux.js-LICENSE.txt
unzip -tq "$archive"
echo "$archive"
