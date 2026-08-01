# Changelog

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
