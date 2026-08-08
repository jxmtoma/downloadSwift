# Video & Media Downloader Privacy Policy

Effective: August 4, 2026

Video & Media Downloader has one purpose: detect media requested by a page the user chooses
and save user-selected media to the user's device.

## Data handled on the device

To provide that feature, the extension processes HTTPS media URLs, page titles,
download status, and limited request metadata (`Accept`, `Origin`, `Range`, and
`Referer`). The browser may send the user's existing cookies directly back to the
same HTTPS media host when fetching a selected file. The extension does not
read, store, or transmit cookie values to the developer.

Detected media and download history are kept in the browser's session storage.
Temporary media files are kept in browser-managed local storage only while a
download is being prepared, then deleted after completion, cancellation, or
failure. In Safari, which cannot report when its save flow has finished reading
a prepared file, that file is instead deleted when the extension next starts.
Completed files remain in the user's Downloads folder until the user deletes
them.

## No developer collection

The extension has no analytics, advertising, tracking, or developer-operated
backend. The developer does not receive, sell, share, or use browsing activity,
media URLs, page titles, request metadata, downloaded files, or payment data.
Media requests go only to the website or media host selected by the user.

## Permissions

- Site access and `webRequest`: detect media requests on sites the user enables.
- `declarativeNetRequest`: replay only the request context needed for a
  user-selected media URL.
- `downloads` and `downloads.open`: save the prepared file and perform only the
  open/show action selected by the user in Chrome, Edge, and Firefox. Chrome and
  Edge also use `downloads.ui` to suppress duplicate browser download UI during
  the managed handoff. Safari requests none of these permissions and hands the
  prepared file to its native save flow.
- `offscreen`: prepare direct and HLS downloads without opening another tab in
  Chrome and Edge. Firefox and Safari perform the same work in a background page.
- `storage`: keep detected items and download state for the browser session.
- `notifications`: tell the user when a download finishes in Chrome, Edge, and
  Firefox. Safari does not request this permission.

## User choices

Site access is optional and can be disabled from the extension. Detected items
and completed-session history can be cleared in the popup. Removing the
extension deletes its browser-managed data.

The extension is intended only for media the user owns or has permission to
download. It does not support YouTube, DRM, encrypted streams, paywall bypassing,
or access-control bypassing.

Use of information received from browser APIs adheres to the applicable Chrome
Web Store, Microsoft Edge Add-ons, Mozilla Add-on, and Apple App Store policies.

For privacy questions, contact the support address listed on the extension's
store page.
