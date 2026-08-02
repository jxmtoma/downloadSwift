# Video & Media Downloader

A self-contained Chrome Manifest V3 extension that detects direct video files
and HLS/DASH playlist URLs requested over HTTPS by the current tab.

[Product website](https://jxmtoma.github.io/downloadSwift/) ·
[Privacy policy](https://jxmtoma.github.io/downloadSwift/privacy/) ·
[Support](https://jxmtoma.github.io/downloadSwift/support/)

## Load it in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open the extension and enable media detection.
5. Play a video, then reopen the extension.

Direct video files can be downloaded. Unencrypted on-demand HLS (`.m3u8`)
streams with combined audio and video are saved as MP4. MPEG-TS streams using
H.264/AAC are transmuxed without re-encoding and finalized with a seekable
timeline. Direct and HLS downloads use the extension's progress UI and save
automatically to Chrome's default Downloads folder. Active progress is visible
from the popup on any tab, downloads continue after their source tab closes, and
Chrome sends a notification when each file is saved. The popup separates
**Detected**, **Downloading**, and **Downloaded** media for the current browser
session. The detector keeps one HLS playlist per tab and prefers a `master.m3u8`
URL when available. DASH (`.mpd`) playlist URLs can be copied for use in a
compatible player such as VLC.

Media URLs are stored only in Chrome's in-memory session storage and are never
sent to the developer. Detection requires optional access to HTTPS sites because
video pages commonly use a different CDN domain.

For direct files, the extension streams the video through its hidden worker
before handing Chrome a local file. It temporarily replays the detected
request's `Referer`, `Origin`, `Accept`, and normalized `Range` headers only for
that exact media URL, and only for the extension's own requests. When no
`Referer` was captured, the page's own origin is used in its place. The session
rule is removed as soon as the remote transfer finishes or fails.

## Check

```sh
node test-media.mjs && node test-hls.mjs && node test-remux.mjs && node test-download-flow.mjs && node test-presubmit.mjs
```

For manual testing, `scripts/test-server.mjs` serves local HTTPS media built from
`test-fixtures/h264-aac.ts`, including a one-shot 503, a permanent 403, and
hotlink protection behind a long signed URL. It prints a per-scenario checklist
on startup.

```sh
node scripts/test-server.mjs
```

The popup and manifest follow Chrome's browser UI language automatically.
English, Spanish, French, German, Brazilian Portuguese, Japanese, Korean,
Simplified Chinese, and Traditional Chinese are included; other languages fall
back to English.

## Current scope

- Direct HTTPS MP4, WebM, MOV, and M4V files
- Unencrypted on-demand HTTPS HLS download as MP4
- DASH playlist discovery
- No YouTube, DRM, stream decryption, live recording, separate audio/video
  merging, access-control bypassing, or site-specific adapters

See [PUBLISHING.md](PUBLISHING.md) for the release checklist and pricing plan,
and [PRIVACY.md](PRIVACY.md) for the privacy policy.

Chrome Web Store graphics are in [`store-assets`](store-assets).

`vendor/mux-mp4.min.js` is mux.js 6.3.0, licensed under Apache-2.0. Its license
is included at `vendor/mux.js-LICENSE.txt`.

Video & Media Downloader's original code is licensed under the [MIT License](LICENSE).
