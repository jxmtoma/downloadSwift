# Browser compatibility

What the three engines actually differ on, and what each difference cost us.
[PUBLISHING.md](PUBLISHING.md) covers store submission; [CHANGELOG.md](CHANGELOG.md)
covers when things changed. This file is the reference you read *before* writing
code that touches a browser API.

## The one rule

One source tree, three packages. Differences live in exactly two places:

- **Manifest** — [`scripts/browser-manifest.mjs`](scripts/browser-manifest.mjs)
  transforms `manifest.json` per target.
- **Runtime** — capability checks, not browser names. `typeof document !== "undefined"`
  distinguishes a background page from a service worker; `api.downloads?.download`
  tells you whether the downloads API exists.

Never fork a module per browser. Two hand-synced file lists is how a build ends up
silently missing a module only one browser loads — see the single `shared_files`
list in [`scripts/package.sh`](scripts/package.sh).

## Capability matrix

| | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| Minimum version | 116 | 142.0 | 26.0 |
| Background context | service worker (module) | background page | background page |
| Dynamic `import()` in background | ✗ forbidden | ✓ | ✓ |
| Offscreen document | ✓ | ✗ | ✗ |
| `downloads` API | ✓ | ✓ | ✗ |
| `downloads.open` / `downloads.ui` | ✓ | ✗ | ✗ |
| Notifications | ✓ with action buttons | ✓ click only | ✗ |
| DNR `tabIds` condition | ✓ | ✗ rejects whole rule | ✗ rejects whole rule |
| DNR `requestDomains` | ✓ | ✓ | ✓ (16.4+) |
| DNR `regexFilter` | ✓ (memory-budgeted) | varies | varies |
| `webRequest` `extraHeaders` | ✓ | ✗ | ✗ |
| `FileSystemFileHandle.createWritable` | ✓ | ✓ | ✓ 26+ only |
| Host permission grant | blanket pattern | blanket pattern | one site at a time |
| Reply timing on `sendMessage` | immediate | after job finishes | after job finishes |

## What each difference cost

Ordered by how long it took to find, not by severity.

### Chrome / Edge

- **Dynamic import in a service worker is forbidden.** The worker reached for the
  preparation code with `import()`, which failed *every* download. Fix: an entry
  point that imports both halves statically.
- **Detect the context by `document`, not by the `browser` namespace.** Chrome now
  defines `browser` too, so the old check sent Chrome down the background-page
  path and straight into that forbidden dynamic import
  ([`service-worker.mjs:5`](service-worker.mjs:5)).
- **Anchored `urlFilter`, not `regexFilter`.** Signed CDN URLs are long enough to
  trip Chrome's per-rule regex memory budget.
- **Edge is the same ZIP.** Every API used here is supported in Edge MV3. No
  separate build, but do sideload and run the matrix before claiming support.

### Firefox

- **DNR rejects the entire rule on an unknown condition property.** `tabIds`
  doesn't exist there, and the rejection took down every HLS/DASH download before
  it started — not a degraded path, a total failure. `tabIds` is now applied only
  when there's no background page ([`service-worker.mjs:257`](service-worker.mjs:257)).
- **No notification action buttons.** Completed files open on notification *click*
  instead.
- **No offscreen document.** Preparation runs in the background page. Keep those
  jobs alive until their background message completes.
- **Promise-based API namespace** and a narrower set of `webRequest` listener
  options (`extraHeaders` is Chrome-only).

### Safari

- **No downloads API and no notifications API at all.** The manifest omits both
  permissions rather than requesting what Safari can't honour. Completion is
  reported by pointing the user at Safari's own Downloads list.
- **A `download` attribute clicked from a background page is ignored.** Silently —
  the file was built and then never saved. Finished jobs now park with a **Save**
  button and are saved from the popup, where the click is a real user gesture
  ([`popup.js:152`](popup.js:152)).
- **The popup reading the file back gave a zero-byte blob** while the page that
  wrote it saw the full bytes. The writing page now reads it and hands the popup a
  URL ([`offscreen.js:292`](offscreen.js:292)). This one burned the most time.
- **A file read out of OPFS carries no MIME type**, and a typeless blob URL made
  Safari show an empty player. `file.slice(0, file.size, "video/mp4")` re-labels
  it without copying bytes.
- **Safari 26 is the floor.** Below it `createWritable` writes are accepted and
  nothing is kept — a silent zero-byte file, not an error.
- **Host access is granted one site at a time.** The blanket HTTPS pattern never
  read back as granted, so detection couldn't be switched on at all. Ask for
  access to the active tab's site.

### All three

- **Ask for host access across sites, not for the page's own origin.** Video pages
  serve media from another domain; an origin-scoped grant detects nothing.
- **Let the job report its own failure.** Reading the `sendMessage` reply meant
  guessing which browser answers when, and guessing wrong turned every real cause
  into "could not start the download".
- **Load detection separately from the download machinery.** One shared module
  graph meant a failure loading preparation code stopped detection too.
- **Progressive MP4, not fragmented.** macOS reads zero packets and zero duration
  from a fragmented MP4 on disk, so correctly-saved streams played broken in every
  browser on macOS while the same file played fine on Windows.

## Open on Safari

[PUBLISHING.md](PUBLISHING.md) still carries a **"Do not submit the Safari build
yet"** block describing the zero-byte save. The 0.4.0 changelog and
[`test-safari.mjs`](test-safari.mjs) say that specific bug is fixed. Confirm
against a real Safari 26 build, then either clear that block or replace it with
whatever is actually still failing.

## Checking a change

```bash
node test-firefox.mjs && node test-safari.mjs && node test-presubmit.mjs
```

`test-firefox.mjs` and `test-safari.mjs` fake each engine's API surface — a rule
Firefox would reject, or a Safari save path that yields zero bytes, fails there
rather than in review. `test-presubmit.mjs` asserts the generated manifests.
Add a case to the relevant file whenever a new browser difference is found.
