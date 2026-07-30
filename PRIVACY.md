# DownloadSwift Privacy Policy

Effective: July 28, 2026

DownloadSwift has one purpose: detect media requested by a page the user chooses
and save user-selected media to the user's device.

## Data handled on the device

To provide that feature, the extension processes HTTPS media URLs, page titles,
download status, and limited request metadata (`Accept`, `Origin`, `Range`, and
`Referer`). Chrome may send the user's existing cookies directly back to the
same HTTPS media host when fetching a selected file. The extension does not
read, store, or transmit cookie values to the developer.

Detected media and download history are kept in Chrome's session storage.
Temporary media files are kept in browser-managed local storage only while a
download is being prepared, then deleted after completion, cancellation, or
failure. Completed files remain in the user's Downloads folder until the user
deletes them.

## No developer collection

The extension has no analytics, advertising, tracking, or developer-operated
backend. The developer does not receive, sell, share, or use browsing activity,
media URLs, page titles, request metadata, downloaded files, or payment data.
Media requests go only to the website or media host selected by the user.

## Permissions

- Site access and `webRequest`: detect media requests on sites the user enables.
- `declarativeNetRequest`: replay only the request context needed for a
  user-selected media URL.
- `downloads` and `downloads.ui`: save the prepared file through Chrome.
- `offscreen`: prepare direct and HLS downloads without opening another tab.
- `storage`: keep detected items and download state for the browser session.
- `notifications`: tell the user when a download finishes.

## User choices

Site access is optional and can be disabled from the extension. Detected items
and completed-session history can be cleared in the popup. Removing the
extension deletes its browser-managed data.

The extension is intended only for media the user owns or has permission to
download. It does not support YouTube, DRM, encrypted streams, paywall bypassing,
or access-control bypassing.

Use of information received from Chrome APIs adheres to the Chrome Web Store
User Data Policy, including its Limited Use requirements.

For privacy questions, contact the support address listed on the extension's
Chrome Web Store page.
