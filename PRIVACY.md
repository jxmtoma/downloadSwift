# Video & Media Downloader Privacy Policy

Effective: October 14, 2026

Video & Media Downloader has one purpose: detect media requested by a page the user chooses
and save user-selected media to the user's device.

## Data processed by the extension

To provide that feature, the extension processes HTTPS media URLs, page titles,
download status, and limited request metadata (`Accept`, `Origin`, `Range`, and
`Referer`). When detected media is shown, the extension may automatically fetch
previews, quality options, and size estimates before the user clicks Download.
Those requests can include site API endpoints, playlist or manifest URLs, and
media/CDN hosts, including hosts derived from a playlist or manifest. The browser
may include permitted existing cookies, and the extension may replay the limited
headers, on these requests and on downloads. The extension does not read or store
cookie values, and does not transmit cookie values to the developer.

Detected media and download-job history are kept in the browser's session
storage. Temporary prepared or staged files are stored in browser-managed local
disk storage. Normal completion, cancellation, and failure attempt to
remove these files, but an interruption or cleanup failure can leave them behind.
The cleanup sweep preserves any temporary file referenced by a stored download
job, regardless of that job's state. In Safari, save completion is not observable,
so a completed handoff may keep its file for as long as the job continues to
reference it. Unreferenced files become eligible for a later cleanup sweep after
the job is cleared or the session ends; deletion is not guaranteed at the next
extension start. Completed files in the browser's Downloads location remain under
the user's control.

## No developer telemetry

The extension has no developer telemetry, analytics, advertising, tracking, or
developer-operated backend. Its media and preparatory requests go to relevant site
APIs and media/CDN hosts. The extension does not send cookie values to the
developer.

## Permissions

- Site access and `webRequest`: detect media requests on sites the user enables.
- `declarativeNetRequest`: replay limited request headers for media and related
  API, playlist, manifest, and CDN requests. In Firefox and Safari background-page
  mode, the existing rules omit tab and initiator restrictions and match direct
  media URLs or stream hosts; while active, matching page or other requests may
  also receive the replayed headers.
- `downloads` and `downloads.open`: save the prepared file and perform only the
  open/show action selected by the user in Chrome and Edge. Firefox saves and
  reveals the file but does not request `downloads.open`, which it permits only
  from a user action. Chrome and Edge also use `downloads.ui` to suppress
  duplicate browser download UI during the managed handoff. Safari requests none
  of these permissions and hands the prepared file to its native save flow.
- `offscreen`: prepare direct, HLS, and DASH downloads without opening another tab
  in Chrome and Edge. Firefox and Safari perform the same work in a background page.
- `storage`: keep detected items and download state for the browser session.
- `notifications`: tell the user when a download finishes in Chrome, Edge, and
  Firefox. Safari does not request this permission.

## User choices

Site access is optional and can be disabled from the extension. Detected items
and completed-session history can be cleared in the popup. Removing the
extension deletes its browser-managed data.

The extension is intended only for media the user owns or has permission to
download. It supports compatible on-demand HLS, including AES-128, and does not
support YouTube, DRM, other HLS encryption, encrypted DASH streams, paywall
bypassing, or access-control bypassing.

Use of information received from browser APIs adheres to the applicable Chrome
Web Store, Microsoft Edge Add-ons, Mozilla Add-on, and Apple App Store policies.

For privacy questions, contact the support address listed on the extension's
store page.
