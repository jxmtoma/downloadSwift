# Video & Media Downloader store assets

These sizes are accepted by both the Chrome Web Store and Microsoft Edge
Add-ons. Reuse the same files for both listings.

- `icon-128.png`: required store icon
- `screenshot-detected.png`: detected media with frame previews, 1280×800
- `screenshot-downloading.png`: cross-tab progress, 1280×800
- `screenshot-free.png`: free/no-account framing over the downloaded list, 1280×800
- `small-promo-440x280.png`: required promotional tile
- `marquee-1400x560.png`: optional marquee promotional image

The three screenshots deliberately show three different popup states — detected,
downloading, downloaded — so no two repeat the same list.

## Regenerating the screenshots

`popup-preview.html` builds its rows the way `popup.js` builds them, against the
real `popup.html` and `popup.css`, so a screenshot shows the shipping UI rather
than a mock that drifts from it. The media is fictional; `preview-frame-a.jpg`
and `preview-frame-b.jpg` are illustrative 16:9 frames standing in for the
previews the extension decodes from the media itself.

Regenerate after any material UI change. `popup-preview.html` fetches
`popup.html`, so it needs to be served over HTTP — `file://` fails on CORS.

```sh
python3 -m http.server 8931
```

Then, from another shell, with any headless Chromium-based browser:

```sh
for view in detected downloading free; do
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1280,800 --virtual-time-budget=6000 \
    --screenshot="store-assets/screenshot-$view.png" \
    "http://localhost:8931/store-assets/screenshot.html?view=$view"
done
```

`--force-device-scale-factor=1` keeps the output at exactly 1280×800, and
`--virtual-time-budget` gives the popup's module script time to build the rows.
The iframe takes its height from the loaded popup, so adding or removing a row
will not reintroduce a scrollbar or a band of dead space.

Firefox reuses the 1280×800 screenshots and the 32px/64px manifest icons.
Safari reuses the screenshots and references `icon.svg` as its 512px extension
icon; Apple's packager renders the macOS app icon from that scalable source.
