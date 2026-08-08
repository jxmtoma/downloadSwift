import assert from "node:assert/strict";

// Safari, like Firefox, rejects a rule whose condition carries an undefined
// property. Chrome-only conditions such as tabIds must never reach it.
const CONDITION_KEYS = new Set([
  "domainType", "excludedInitiatorDomains", "excludedRequestDomains",
  "excludedRequestMethods", "excludedResourceTypes", "initiatorDomains",
  "isUrlFilterCaseSensitive", "regexFilter", "requestDomains", "requestMethods",
  "resourceTypes", "urlFilter"
]);

const stored = {};
const runtimeListeners = [];
const addedRules = [];
const sessionRules = [];
const requestHeaderOptions = [];
const fileChunks = [];
const removedFiles = [];
const directoryEntries = [];
const positionedWrites = [];
let clickedLink;

const event = () => ({ addListener: () => {}, removeListener: () => {} });
globalThis.browser = {
  action: { setBadgeText: async () => {} },
  declarativeNetRequest: {
    getSessionRules: async () => sessionRules,
    updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => {
      for (const rule of addRules) {
        for (const key of Object.keys(rule.condition)) {
          if (CONDITION_KEYS.has(key)) continue;
          throw new Error(`Unexpected condition property "${key}"`);
        }
      }
      addedRules.push(...addRules);
      sessionRules.push(...addRules);
      for (const id of removeRuleIds) {
        const index = sessionRules.findIndex((rule) => rule.id === id);
        if (index >= 0) sessionRules.splice(index, 1);
      }
    }
  },
  i18n: { getMessage: (key) => key },
  permissions: { onAdded: event(), onRemoved: event() },
  runtime: {
    getURL: (path) => `safari-web-extension://test/${path}`,
    onInstalled: event(),
    onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
    onStartup: event()
  },
  storage: {
    session: {
      get: async (key) => key === null ? { ...stored } : { [key]: stored[key] },
      remove: async (key) => {
        for (const item of Array.isArray(key) ? key : [key]) delete stored[item];
      },
      set: async (items) => Object.assign(stored, items)
    }
  },
  tabs: { onRemoved: event(), onUpdated: event() },
  webRequest: {
    onBeforeSendHeaders: {
      addListener: (_listener, _filter, options) => requestHeaderOptions.push(options),
      removeListener: () => {}
    },
    onCompleted: event(),
    onErrorOccurred: event(),
    onHeadersReceived: event()
  }
};

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    body: { append: (link) => { clickedLink = link; } },
    createElement: () => ({
      click() { this.clicked = true; },
      remove() { this.removed = true; }
    })
  }
});

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    storage: {
      getDirectory: async () => ({
        getFileHandle: async () => ({
          createWritable: async () => ({
            abort: async () => {},
            close: async () => {},
            // Appends whatever it is given and ignores a position, which is how a
            // browser without positioned-write support behaves. A file assembled
            // by seeking back to its start comes out scrambled on one of these.
            write: async (chunk) => {
              positionedWrites.push(Boolean(chunk && chunk.type === "write"));
              fileChunks.push(chunk && chunk.type === "write" ? chunk.data : chunk);
            }
          }),
          getFile: async () => new File(fileChunks, "temp.mp4")
        }),
        keys: async function* () { yield* directoryEntries; },
        removeEntry: async (name) => {
          removedFiles.push(name);
          const index = directoryEntries.indexOf(name);
          if (index >= 0) directoryEntries.splice(index, 1);
        }
      })
    }
  }
});

globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), {
  headers: { "content-length": "4" }
});
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => (
  nativeSetTimeout(callback, delay === 1000 ? 0 : delay, ...args)
);

// background.mjs is what these browsers actually load: it imports both halves
// and wires them to each other, which is what replaced the dynamic import a
// service worker was never allowed to make.
await import("./background.mjs");
assert.deepEqual(requestHeaderOptions, [["requestHeaders"]]);

const job = {
  id: "safari-direct",
  item: {
    kind: "file",
    requestHeaders: [{ name: "referer", value: "https://video.example/watch" }],
    url: "https://cdn.example/video.mp4"
  },
  state: "queued"
};
stored[`download-job:${job.id}`] = job;

const response = await new Promise((resolve) => {
  runtimeListeners[0]({
    filename: "Safari video.mp4",
    job,
    target: "service-worker",
    type: "start-direct"
  }, null, resolve);
});

assert.equal(response.ok, true);
assert.deepEqual(addedRules[0].condition, {
  isUrlFilterCaseSensitive: true,
  urlFilter: "|https://cdn.example/video.mp4|"
});
assert.equal(sessionRules.length, 0);
// Safari refuses a download attribute clicked from a background page, so nothing
// is clicked here. The job parks with the file it built, and the popup saves it
// on the user's own click, where there is a real gesture in a rendered document.
assert.equal(clickedLink, undefined, "a background page must not try to click");
const parked = stored[`download-job:${job.id}`];
assert.equal(parked.state, "ready");
assert.equal(parked.status, "status_ready_to_save");
assert.equal(parked.filename, "Safari video.mp4");
assert.equal(parked.tempName, `downloadswift-${job.id}.mp4`, "the popup needs the file, not a blob URL that dies with this page");
assert.deepEqual(removedFiles, [], "the parked file must outlive the job");

// The capability is measured, not assumed: this storage ignores a position, so
// nothing may be written out of order. Doing so left the header sitting where
// the media should be and the saved file unplayable.
assert.ok(positionedWrites.length > 0, "the writable was exercised");
assert.ok(
  !positionedWrites.some(Boolean) || positionedWrites.filter(Boolean).length <= 1,
  "only the capability probe may attempt a positioned write here"
);

// The save goes through the page that wrote the file. Reading it from the popup
// instead handed back a zero-byte blob, and Safari saved zero bytes, even though
// this side had already checked the same file was not empty.
fileChunks.length = 0;
fileChunks.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
const savePrepared = await new Promise((resolve) => {
  runtimeListeners[0]({
    jobId: job.id,
    target: "service-worker",
    type: "prepare-save"
  }, null, resolve);
});
assert.equal(savePrepared.ok, true);
assert.equal(savePrepared.size, 8, "the size comes from the file, not from a guess");
assert.match(savePrepared.url, /^blob:/, "the popup is handed a URL, not asked to read storage");

// An empty file is refused here rather than saved as zero bytes.
fileChunks.length = 0;
const emptyPrepared = await new Promise((resolve) => {
  runtimeListeners[0]({
    jobId: job.id,
    target: "service-worker",
    type: "prepare-save"
  }, null, resolve);
});
assert.equal(emptyPrepared.ok, false);
assert.match(emptyPrepared.error, /error_empty_output/);
fileChunks.push(new Uint8Array([1, 2, 3, 4]));

// The prepared file is handed on as video/mp4. A file read back out of storage
// has no type of its own, and a typeless blob URL is what left Safari showing an
// empty player instead of the video.
const { asVideoBlob } = await import("./offscreen.js");
const typeless = new File([new Uint8Array([1, 2, 3])], "temp.mp4");
assert.equal(typeless.type, "", "storage hands back a file with no type");
const labelled = asVideoBlob(typeless);
assert.equal(labelled.type, "video/mp4");
assert.equal(labelled.size, typeless.size, "re-labelling must not change the bytes");

// Leftovers are collected when the extension context next starts. A file a job
// in this context still owns is not a leftover.
const offscreen = await import("./offscreen.js");
directoryEntries.push(`downloadswift-${job.id}.mp4`, "downloadswift-stale.mp4", "unrelated.bin");
await offscreen.sweepTempFiles();
assert.deepEqual(removedFiles, ["downloadswift-stale.mp4"]);
removedFiles.length = 0;

// A parked file survives a restart, when nothing is running and only storage
// says it is still wanted. Sweeping it would delete the download before the
// user ever got to press Save.
const restarted = await import(`./offscreen.js?restart=${Date.now()}`);
directoryEntries.push(`downloadswift-${job.id}.mp4`, "downloadswift-orphan.mp4");
await restarted.sweepTempFiles();
assert.deepEqual(removedFiles, ["downloadswift-orphan.mp4"]);
removedFiles.length = 0;

sessionRules.push({ id: 7 });
stored["download-job:safari-hls"] = {
  id: "safari-hls",
  item: {
    requestHeaders: [{ name: "referer", value: "https://video.example/watch" }],
    url: "https://playlist.example/master.m3u8"
  },
  ruleId: 7
};
const extended = await new Promise((resolve) => {
  runtimeListeners[0]({
    hosts: ["playlist.example", "segments.example"],
    jobId: "safari-hls",
    target: "service-worker",
    type: "extend-headers"
  }, null, resolve);
});
assert.equal(extended.ok, true);
// requestDomains, not a regex: it has been in Safari since 16.4 and this build
// requires 17.0, while regexFilter syntax varies by browser and a rejected
// condition takes down every stream download.
assert.deepEqual(sessionRules[0].condition, {
  requestDomains: ["playlist.example", "segments.example"]
});

console.log("Safari compatibility check passed");
