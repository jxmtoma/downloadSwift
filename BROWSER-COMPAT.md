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
- **No notification action buttons**, and a notification click is not a user
  action ([1523523](https://bugzilla.mozilla.org/show_bug.cgi?id=1523523)), which
  `downloads.open` requires. Both routes to opening a finished file are therefore
  closed, and the click *reveals* it in the Downloads panel instead —
  `downloads.show` carries no such rule. The manifest drops the `downloads.open`
  permission rather than request one nothing can call.
- **No offscreen document.** Preparation runs in the background page. Keep those
  jobs alive until their background message completes.
- **Promise-based API namespace** and a narrower set of `webRequest` listener
  options (`extraHeaders` is Chrome-only).

### Safari

- **No downloads API and no notifications API at all.** The manifest omits both
  permissions rather than requesting what Safari can't honour. Completion is
  reported by pointing the user at Safari's own Downloads list.
- **A `download` attribute is ignored outside an ordinary tab.** Clicked from the
  background page it does nothing at all; clicked from the popover it becomes a
  *navigation*, so Safari opened the blob in a tab and played it instead of saving
  it. Neither context can save. Finished jobs park with a **Save** button that
  opens [`save.html`](save.html) in a real tab, and the download happens there
  ([`popup.js:152`](popup.js:152)). From a tab the attribute is honoured and the
  filename sticks.
- **A blob URL dies with the document that made it, and Safari kills that document
  fast.** The background page handed the popup a URL; Safari unloads that page
  within a couple of minutes, after which the tab playing it froze mid-video and
  saving wrote nothing. The popover is worse — it is destroyed the moment focus
  leaves it. Only a tab lives long enough, so [`save.js`](save.js) opens the file
  out of OPFS and makes its own blob.
- **The popup reading the file back gave a zero-byte blob** while the page that
  wrote it saw the full bytes. That is what pushed the blob into the background
  page in the first place. Re-checked on 26.5.2 and it no longer reproduces: a
  second document reads the full bytes straight out of OPFS, which is what makes
  the save page possible.
- **The sweep deleted the file out from under a save that was still running.**
  Safari's save is an anchor click it services on its own schedule, with no event
  to say it finished. The popup marks the job `complete` the instant it clicks, and
  `sweepTempFiles` only treated a `ready` job as owning its file, so any background
  page load in that gap swept the file mid-save and Safari wrote a zero-byte
  `unknown.mp4` — "unknown" because with the bytes gone it cannot apply the
  download attribute's name either. A job now owns its file for as long as the job
  row exists ([`offscreen.js:241`](offscreen.js:241)). A 45-second gap between the
  click and the file appearing on disk is normal, so the window is wide.
- **A file read out of OPFS carries the wrong MIME type**, and a bad blob URL type
  made Safari show an empty player. `file.slice(0, file.size, "video/mp4")` re-labels
  it without copying bytes. On 26.5.2 the file comes back as `application/macbinary`
  rather than typeless, so the re-label matters more, not less.
- **Downloads need per-site permission, and the extension's "site" is its UUID.**
  Safari's default is **Ask**, so the first save shows "Do you want to allow
  downloads on <uuid>?" and nothing reaches disk until it is answered. The UUID is
  regenerated every time the extension is reloaded or reinstalled, so the grant
  does not survive an update — expect the prompt again after every release, and do
  not treat a silent no-op as a bug before checking Settings ▸ Websites ▸ Downloads.
- **Safari 26 is the floor.** Below it `createWritable` writes are accepted and
  nothing is kept — a silent zero-byte file, not an error.
- **Host access used to be granted one site at a time.** The blanket HTTPS pattern
  never read back as granted, so detection couldn't be switched on at all, and the
  code asks for access to the active tab's site. On 26.5.2 the blanket pattern does
  read back: `permissions.getAll()` in the background page returns
  `origins: ["https://*/*"]`. Per-site asking still works and is still the safer
  request, so it was left alone — but do not use "the blanket pattern is impossible"
  to justify anything new.

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

Checked against a real Safari 26.5.2 build on 2026-08-08. Two separate faults were
breaking the save, and fixing only the first left it still broken:

1. **The sweep deleted the file mid-save.** Evidence was two files in `~/Downloads`
   from the same extension — a 333 MB video that saved correctly, and a 0-byte
   `unknown.mp4` written 45 seconds after its job was marked complete. Fixed by
   making a job own its file for as long as the job row exists. Proof it worked: a
   362 MB temp file then survived a completed job and several background-page
   unloads.
2. **The handoff itself.** With the bytes surviving, the save still failed — the
   blob belonged to the background page, so the tab Safari opened played for two
   minutes and froze, and saving out of it produced page source. Fixed by moving
   the save into [`save.html`](save.html).

Verified end to end on 2026-08-08: clicking **Save** opened the save tab, and the
download landed as `save-test.mp4` at exactly the 1,048,576 bytes written to OPFS,
byte-for-byte, under the job's own filename. What has *not* been re-run since the
change is a full real-world download (detect ▸ download ▸ save) on a live stream;
[PUBLISHING.md](PUBLISHING.md) keeps its **"Do not submit"** block until it has.

Before touching the save path again: `showSaveFilePicker` does not exist in 26.5.2,
so an anchor click on a blob URL is the only way out; a blob URL dies with the
document that made it; and the Develop menu shows the background page as
"(not loaded)" most of the time, which is exactly why nothing durable can live
there.

## Checking a change

```bash
node test-firefox.mjs && node test-safari.mjs && node test-presubmit.mjs
```

`test-firefox.mjs` and `test-safari.mjs` fake each engine's API surface — a rule
Firefox would reject, or a Safari save path that yields zero bytes, fails there
rather than in review. `test-presubmit.mjs` asserts the generated manifests.
Add a case to the relevant file whenever a new browser difference is found.
