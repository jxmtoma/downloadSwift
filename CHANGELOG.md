# Changelog

## 0.4.0 — 2026-08-04

- Read the prepared file in the page that wrote it and hand the popup a URL,
  rather than having the popup open the same file itself. On Safari the popup's
  read came back empty and saved a zero-byte file, while the page that wrote it
  had already checked the very same file was not empty.
- State a video's composition offsets as ctts version 0, with the offsets shifted
  so none is negative, and collapse runs of equal offsets. Version 1's signed
  offsets are read far less reliably, and every video encoded with B-frames — most
  of them — depends on this table being understood.
- Measure whether storage supports writing at a position before relying on it.
  The finished file's header can only be filled in once the media length is
  known, and a browser that ignores the position appends it instead, leaving the
  header in the middle of the media and the file unplayable. Where it is not
  supported the media is staged in a second file and the finished one is written
  straight through, which produces a byte-identical result.
- Ask for host access across sites rather than for the page's own origin. A
  video page serves its media from another domain, and a grant covering only the
  page could not see those requests, so nothing was detected at all.
- Load detection separately from the download machinery on Firefox and Safari.
  Both halves shared one module graph, so any failure while loading the
  preparation code stopped media being detected at all rather than only stopping
  downloads.
- Write downloads as progressive MP4 rather than fragmented. macOS does not read
  a fragmented MP4 from disk at all: CoreAudio reports zero packets and zero
  duration for one, so streams saved correctly still played broken in Safari,
  Chrome and Firefox on macOS while the same file played on Windows. The samples
  are now described once in real sample tables, and the file opens with ftyp,
  without which macOS rejects it outright.
- Load the background page through an entry point that imports both halves
  statically. The worker reached for the preparation code with a dynamic import,
  which a service worker is forbidden to run, so a single wrong guess about
  which context it was in failed every download on Chrome.
- Fail a download that reads back as an empty file instead of handing over zero
  bytes, which is what a browser without the storage write API produces.
- Require Safari 26, the release that added the file-writing API every download
  depends on. Below it the writes are accepted and nothing is kept.
- Let a download's own state report why it failed instead of the popup reading
  the reply to find out. Which browser answers when differs, and guessing wrong
  turned every real cause into "could not start the download".
- Label a prepared file as video/mp4 when handing it on. A file read back out of
  storage carries no type, and a typeless blob URL left Safari showing an empty
  player instead of the video.
- Detect the background context by whether it has a document rather than by the
  presence of a `browser` namespace, which Chrome now defines too. Chrome was
  taking the background-page path and reaching a dynamic import that a service
  worker is forbidden to make, so every download failed there.
- Save on Safari from the popup, on the user's own click. Safari does not honour
  a download attribute clicked from a background page, so the file was built and
  then silently never saved. A finished job now waits with a Save button, and
  its file survives a restart until it is saved.
- Stop showing a stream's manifest size as if it were the video's. The number
  was the length of the text file listing the segments, so a two-hour stream
  read as 29 KB. Streams whose tracks are single files now report their exact
  size, and the rest an approximate one derived from bitrate and runtime.
- Say where a file went on Safari, which has no downloads API to report
  completion: the popup now points at Safari's own Downloads list.
- Write a merged stream's video and audio fragments in playback order rather
  than one whole track after the other. A player walking the file in order read
  the two timelines end to end and reported a video twice as long as it is.
- Show the preview frame larger and at the shape of the video, so a wide clip is
  no longer cropped into a small square and a vertical one keeps its whole frame.
- Scope a stream's header replay by request domain on every browser. Safari and
  Firefox were sent a regular-expression condition instead, and a rejected
  condition failed every HLS and DASH download before it started.
- Report why a stream download could not start instead of a generic message,
  which left the actual cause visible only in storage.
- Preview HLS and DASH streams from their first segment, not just direct files.
- Support bilibili video pages. Its player exposes no manifest to detect, so the
  page is recognised by URL, its streams are resolved through bilibili's own
  endpoints using the browser's session, and the separate video and audio files
  are streamed and merged into one MP4.
- Download on-demand DASH (`.mpd`) manifests as MP4, reading `SegmentTemplate`,
  `SegmentTimeline`, `SegmentList`, and plain `BaseURL` layouts. Manifests that
  keep audio in its own adaptation set have both streams merged into one movie.
- Show a frame from each detected video file in the list, so an ad or player stub
  sharing the same MP4 mime type is obvious at a glance.
- Decode preview frames in the popup. A service worker has no DOM and an
  offscreen document is never rendered, so no frame was ever produced there.
- Stop two downloads or previews started at the same moment from claiming the
  same session rule id, which made whichever lost the race fail outright.
- Ask Safari for access to the site in the active tab. Safari grants host access
  one site at a time, so the blanket HTTPS pattern never read back as granted and
  detection could not be switched on at all.
- Ignore video responses whose known size is too small to be a video, which is
  what most ad and player-stub MP4s are, and read a ranged response's real size
  off `Content-Range` so a large file fetched in slices is never mistaken for one.
- Add a macOS Safari 26+ package that reuses the shared WebExtension source and
  a Safari-compatible background page.
- Hand prepared Safari files to its native save flow without requesting the
  unsupported downloads or notifications APIs, reporting the handoff rather than
  claiming a save Safari cannot confirm.
- Collect temporary preparation files left behind by Safari's handoff or by a
  worker restart when the extension next starts.
- Scope the extension-only request rule to Chrome and Edge, the only browsers
  that support it, so Firefox and Safari header replay is not rejected outright.
- Finish a download whose completion arrives before the browser returns its
  download ID instead of leaving the job stalled.
- Add Safari packaging, compatibility checks, local testing, and App Store
  publishing instructions.
- Add a Firefox Manifest V3 package with a document background context for local
  direct-file and HLS preparation.
- Use Firefox's promise-based WebExtension API namespace and supported request
  listener options.
- Keep Firefox preparation jobs alive until their background message completes.
- Use a notification click to open completed files on Firefox, where extension
  notification action buttons are unavailable.

## 0.3.2 — 2026-08-04

- Show an estimated completion time alongside active download progress.
- Add **Open file** and **Show in folder** actions to completion notifications.
- Support the same Manifest V3 package in Microsoft Edge.

## 0.3.1 — 2026-08-02

- Keep one entry per stream rather than one per tab, so a page that embeds
  several players no longer shows just one of its videos.
- Detect video files a player fetches in the background, including URLs that
  carry no file extension, which embedded players commonly use.
- Stop listing a stream's own segments as separate videos, including segments
  named like ordinary MP4 files.
- Send the page's referrer when downloading a stream, as direct downloads
  already did. Streams from hosts that check it failed with an HTTP error.

## 0.3.0 — 2026-08-01

- Detect media as soon as detection is enabled. Detection previously did not
  begin until the background worker happened to restart, so the first attempt
  on a page appeared to do nothing until it was reloaded several times.
- Reload the current tab when detection is enabled, since media a page has
  already requested cannot be observed afterwards.
- Stop observing media requests immediately when detection is turned off.
- Retry a stream segment that fails instead of abandoning the download.
- Fetch stream segments concurrently, which noticeably shortens long streams.
- Report stream progress on percentage changes rather than once per segment,
  keeping the popup responsive on streams with many segments.
- Start direct downloads whose URLs carry long signing tokens, which could
  previously fail before the transfer began.
- Apply the temporary header rule only to the extension's own requests.
- Use the page's origin as the referrer when the original request's headers
  are no longer available, so hosts that check it still accept the download.

## 0.2.1 — 2026-07-31

- Rename the extension to Video & Media Downloader.

## 0.2.0 — 2026-07-29

- Rename the extension to DownloadSwift and introduce a consistent icon,
  popup palette, and Chrome Web Store identity.
- Restrict detection and downloads to HTTPS media.
- Follow Chrome's UI language in English, Spanish, French, German, Brazilian
  Portuguese, Japanese, Korean, Simplified Chinese, and Traditional Chinese.
- Expand the permission disclosure to cover all locally handled data.

## 0.1.1 — 2026-07-28

- Finalize HLS MP4 duration metadata so downloaded videos report their real
  duration and expose a seekable timeline.

## 0.1.0 — 2026-07-28

- Detect direct video files and HLS/DASH playlists.
- Save direct files and supported on-demand HLS streams with local progress,
  cancellation, MP4 transmuxing, and page-title filenames.
- Continue downloads after the source tab closes and notify on completion.
- Separate detected, downloading, and downloaded popup views.
