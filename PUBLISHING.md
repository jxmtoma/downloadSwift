# Publishing and Monetization

## Release position

Video & Media Downloader saves direct HTTPS MP4/WebM/MOV/M4V files and supported
unencrypted, on-demand HTTPS HLS streams locally. It does not support insecure
HTTP media, YouTube, DRM, encrypted or live HLS, byte-range HLS, separate
audio/video tracks, DASH downloads, paywall bypassing, or access-control
bypassing.

Suggested short description:

> Save direct HTTPS video files and unencrypted HLS streams locally with
> progress, MP4 output, and no tracking.

Suggested listing introduction:

> Video & Media Downloader detects media on the page you choose and saves supported video
> files through a private, on-device workflow. Direct files and compatible HLS
> streams download with progress, cancellation, sensible filenames, background
> continuation, and completion notifications.

Required listing disclosure:

> Video & Media Downloader locally processes media URLs, page titles, download status, and
> limited request headers. When a user downloads a file, those limited headers
> and existing cookies may be sent back to the original HTTPS media host.
> Nothing is sent to the developer.

Use the **Tools** category. Do not list third-party site names or claim universal
compatibility. State clearly that users may download only media they have the
right to save.

## Before submission

- Register the publisher, verify its email, enable 2-Step Verification, and pay
  the one-time Chrome Web Store developer fee.
- In repository **Settings → Pages**, choose **Deploy from a branch**, then
  publish `main` from `/docs`. Use these Developer Dashboard URLs:
  - Product: `https://jxmtoma.github.io/downloadSwift/`
  - Privacy: `https://jxmtoma.github.io/downloadSwift/privacy/`
  - Support: `https://jxmtoma.github.io/downloadSwift/support/`
  GitHub Pages sites are public. Keeping this source repository private requires
  GitHub Pro, Team, or Enterprise; on GitHub Free, publish `/docs` from a
  separate public site-only repository instead.
- In Privacy Practices, disclose handling of website content, media URLs, page
  titles, download status, limited request headers, and same-host cookies.
  Declare that data is processed locally, is not sold, and is not used outside
  the extension's single purpose.
- Upload `store-assets/icon-128.png`, both current 1280×800 screenshots, and
  `store-assets/small-promo-440x280.png`. The 1400×560 marquee is optional.
- Test the packed ZIP on clean Chrome profiles on macOS, Windows, and Linux:
  direct MP4/WebM, TS-HLS, fMP4-HLS, cancel, retry, source-tab closure,
  completion notification, denied site access, HTTP rejection, and each
  supported browser language.
- Upload first as **Private / trusted testers**, then move to public after the
  package and privacy declarations pass review.

Build the store ZIP with:

```sh
sh scripts/package.sh
```

## Monetization decision

Launch completely free and ad-free. Approval, reliability, reviews,
and support feedback are more valuable than early monetization.

Keep the current core free forever:

- Direct-file and supported HLS downloads
- MP4 output, filenames, progress, cancellation, and notifications
- Session download history

If Premium is reconsidered, add it only when several advanced features exist:

- Quality/variant selection and batch queues
- DASH and separate audio/video merging
- Subtitle/audio extraction and live recording
- Persistent history, filename templates, and per-site folders

Do not embed a generic advertising SDK. Manifest V3 disallows remotely hosted
JavaScript, and Chrome Web Store policy prohibits using browsing activity for
personalized advertising. If advertising is added later, use a clearly labeled,
non-personalized direct sponsor card with packaged creative and a user-clicked
destination link. Disclose it in the listing, UI, and privacy policy. A real
sponsor image and destination URL are required before adding that surface.

## Maintenance

For each release: update `manifest.json` version, update `CHANGELOG.md`, run all
checks, inspect the ZIP contents, test the unpacked release on a clean profile,
commit, tag `v<version>`, then upload the exact ZIP produced from that commit.
Review Chrome Web Store policy and mux.js updates before each feature release.
