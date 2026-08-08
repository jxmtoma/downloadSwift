# Video & Media Downloader

A self-contained Manifest V3 extension for Chrome, Microsoft Edge, Firefox, and
macOS Safari that detects direct video files and HLS/DASH playlist URLs requested
over HTTPS by the current tab.

[Product website](https://jxmtoma.github.io/downloadSwift/) ·
[Privacy policy](https://jxmtoma.github.io/downloadSwift/privacy/) ·
[Support](https://jxmtoma.github.io/downloadSwift/support/)

## Load it in Chrome or Microsoft Edge

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open the extension and enable media detection.
5. Play a video, then reopen the extension.

## Load it in Firefox

1. Run `sh scripts/package.sh`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select `dist/firefox/manifest.json`.
4. Open the extension, enable media detection, and play a video.

## Load it in Safari

**Safari is not working yet.** Detection and preparation run, but saving the
finished file does not: Safari ignores the download attribute, and the file the
popup is handed arrives empty even though the page that wrote it reads the same
file as complete. Chrome, Edge, and Firefox are unaffected. Do not publish the
Safari package until this is resolved.

1. Run `sh scripts/package.sh` (Safari 26 or later on macOS).
2. In **Safari → Settings → Advanced**, enable **Show features for web developers**.
3. In the **Developer** settings tab, click **Add Temporary Extension** and select
   `dist/safari`.
4. Enable the extension, grant site access, and play a video.

Safari removes a temporary extension after 24 hours or when Safari quits, and
re-adding it resets website access. Safari offers a choice between allowing the
current site and allowing every site: choose **Always Allow on Every Website**.
Detection watches requests, and a request is only visible on a host the extension
holds permission for, while a video page nearly always serves its media from a
different domain than the page itself.

Direct video files can be downloaded. Unencrypted on-demand HLS (`.m3u8`)
streams with combined audio and video are saved as MP4. Streams are assembled
into a progressive MP4, with the samples described once in the header rather
than ahead of each fragment: macOS reads no fragmented MP4 from disk, so that
layout played broken in every browser there while working on Windows. MPEG-TS streams using
H.264/AAC are transmuxed without re-encoding and finalized with a seekable
timeline. Direct and HLS downloads use the extension's progress UI and hand the
completed file to the browser's save flow. Active progress is visible from the
popup on any tab, downloads continue after their source tab closes, and Chrome and
Edge send a notification with actions to open each saved file or show it in its
folder. Firefox opens the saved file when its completion notification is clicked.
Safari has no WebExtension downloads or notifications API, and does not honour a
download attribute clicked from a background page, so a finished job waits there
with a **Save** button: pressing it saves from the popup, where the click is a
real user gesture. The file is kept until it is saved, including across a
restart. Whether Safari's own save was then accepted or dismissed is not
observable, so no completion actions are offered.
A detected stream shows an exact size when its tracks are single files and an
approximate one, marked with a leading tilde, when they are segment lists.
The popup separates
**Detected**, **Downloading**, and **Downloaded** media for the current browser
session. The detector keeps one HLS playlist per tab and prefers a `master.m3u8`
URL when available. On-demand DASH (`.mpd`) manifests are downloaded as MP4,
reading `SegmentTemplate` (including `SegmentTimeline`), `SegmentList`, and plain
`BaseURL` layouts. When a manifest keeps audio in its own adaptation set, both
streams are fetched and merged into one movie: they are independently authored
and both call themselves track 1, so the merged file gets one header declaring
two tracks and every fragment is renumbered to match. Live DASH is not
supported.

Most sites are found by watching requests, but some players never put a manifest
URL on the wire at all: bilibili asks a private JSON endpoint and hands the
result straight to the player, so nothing is observable. Those pages are
recognised by URL instead, and only once the user has granted access to the site.
The streams are resolved when the download starts, using the browser's existing
session, so the quality offered is whatever that account is entitled to. Each
track is a separate whole file there, streamed and merged rather than buffered.

Media URLs are stored only in the browser's in-memory session storage and are never
sent to the developer. Detection requires optional access to HTTPS sites because
video pages commonly use a different CDN domain.

For direct files, the extension streams the video through its background processor
before handing the browser a local file. It temporarily replays the detected
request's `Referer`, `Origin`, `Accept`, and normalized `Range` headers only for
that exact media URL, and only for the extension's own requests. When no
`Referer` was captured, the page's own origin is used in its place. The session
rule is removed as soon as the remote transfer finishes or fails.

## Check

```sh
node test-media.mjs && node test-hls.mjs && node test-dash.mjs && node test-mp4.mjs && node test-sites.mjs && node test-preview.mjs && node test-remux.mjs && node test-download-flow.mjs && node test-firefox.mjs && node test-safari.mjs && node test-presubmit.mjs
```

For manual testing, `scripts/test-server.mjs` serves local HTTPS media built from
`test-fixtures/h264-aac.ts`, including a one-shot 503, a permanent 403, and
hotlink protection behind a long signed URL. It prints a per-scenario checklist
on startup.

```sh
node scripts/test-server.mjs
```

The popup and manifest follow the browser UI language automatically.
English, Spanish, French, German, Brazilian Portuguese, Japanese, Korean,
Simplified Chinese, and Traditional Chinese are included; other languages fall
back to English.

## Current scope

- Direct HTTPS MP4, WebM, MOV, and M4V files
- Unencrypted on-demand HTTPS HLS download as MP4
- On-demand DASH download as MP4, including manifests that keep audio and video
  in separate adaptation sets
- Bilibili video pages, whose player exposes no manifest URL to detect
- Detected videos show a frame from the media itself, taken from the file or
  from a stream's first segment, so an ad stub sharing the same MP4 mime type is
  obvious at a glance
- No YouTube, DRM, stream decryption, live recording, or access-control
  bypassing

See [PUBLISHING.md](PUBLISHING.md) for the release checklist and pricing plan,
and [PRIVACY.md](PRIVACY.md) for the privacy policy.

Store graphics are in [`store-assets`](store-assets), which documents what each
listing reuses. Chrome, Edge, and Firefox share the icon, screenshots, and
promotional tiles; Safari's App Store icon is rendered by Apple's packager from
[`icon.svg`](icon.svg).

`vendor/mux-mp4.min.js` is mux.js 6.3.0, licensed under Apache-2.0. Its license
is included at `vendor/mux.js-LICENSE.txt`.

Video & Media Downloader's original code is licensed under the [MIT License](LICENSE).
