# downloadSwift

A Manifest V3 WebExtension shipped to Chrome, Edge, Firefox, and Safari from one
source tree. Three packages, no browser-specific forks.

Read before touching a browser API: [BROWSER-COMPAT.md](BROWSER-COMPAT.md) — the
capability matrix and every difference that has already cost us a release.

Read before packaging or submitting: [PUBLISHING.md](PUBLISHING.md).

Full check (all of it, before any release):

```sh
node test-media.mjs && node test-hls.mjs && node test-dash.mjs && node test-mp4.mjs && node test-sites.mjs && node test-preview.mjs && node test-remux.mjs && node test-download-flow.mjs && node test-firefox.mjs && node test-safari.mjs && node test-presubmit.mjs
```

Branch differences on capabilities (`typeof document`, `api.downloads?.download`),
never on browser names.
