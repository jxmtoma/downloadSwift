# Video & Media Downloader store assets

These sizes are accepted by both the Chrome Web Store and Microsoft Edge
Add-ons. Reuse the same files for both listings.

- `icon-128.png`: required store icon
- `screenshot-detected.png`: current detected-media experience, 1280×800
- `screenshot-downloading.png`: current cross-tab progress experience, 1280×800
- `small-promo-440x280.png`: required promotional tile
- `marquee-1400x560.png`: optional marquee promotional image

The screenshots use the real popup markup and stylesheet with fictional example
media. Regenerate them from `screenshot.html` after material UI changes.

Firefox reuses the 1280×800 screenshots and the 32px/64px manifest icons.
Safari reuses the screenshots and references `icon.svg` as its 512px extension
icon; Apple's packager renders the macOS app icon from that scalable source.
