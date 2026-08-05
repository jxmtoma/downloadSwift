# Changelog

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
