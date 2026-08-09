import assert from "node:assert/strict";

// Firefox rejects a whole rule when its condition carries a property the schema
// does not define, which is how a Chrome-only `tabIds` silently broke every
// header replay. Validate the shape the way the browser does.
const CONDITION_KEYS = new Set([
  "domainType", "excludedInitiatorDomains", "excludedRequestDomains",
  "excludedRequestMethods", "excludedResourceTypes", "initiatorDomains",
  "isUrlFilterCaseSensitive", "regexFilter", "requestDomains", "requestMethods",
  "resourceTypes", "urlFilter"
]);

const stored = {
  "download-job:finished": {
    filename: "Firefox video.mp4",
    id: "finished",
    state: "downloading"
  },
  "managed-download:21": { jobId: "finished", offscreen: false }
};
const downloadListeners = [];
const notificationClickListeners = [];
const notifications = [];
const shownDownloads = [];
const requestHeaderOptions = [];
const runtimeListeners = [];
const sessionRules = [];
const addedRules = [];
const startedDownloads = [];
let runtimeMessages = 0;
let nextDownloadId = 21;
// Set to have downloads.download() report completion before it resolves, the
// order Firefox can use for a blob the browser already has on disk.
let completeBeforeDownloadResolves = false;

const event = () => ({ addListener: () => {}, removeListener: () => {} });
globalThis.browser = {
  action: { setBadgeText: async () => {} },
  declarativeNetRequest: {
    getSessionRules: async () => sessionRules,
    updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => {
      for (const rule of addRules) {
        for (const key of Object.keys(rule.condition)) {
          if (CONDITION_KEYS.has(key)) continue;
          throw new Error(
            `Type error for parameter options (Error processing addRules.0.condition: Unexpected property "${key}")`
          );
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
  downloads: {
    cancel: async () => {},
    download: async (options) => {
      startedDownloads.push(options);
      const id = (nextDownloadId += 1);
      if (completeBeforeDownloadResolves) {
        downloadListeners[0]({ id, state: { current: "complete" } });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return id;
    },
    onChanged: { addListener: (listener) => downloadListeners.push(listener) },
    // Firefox refuses downloads.open() outside a user-action handler, and a
    // notification click is not one (bugzilla 1523523). Refuse it the way the
    // browser does, so reaching for it fails here instead of shipping a
    // notification whose click silently does nothing.
    open: () => {
      throw new Error("downloads.open may only be called from a user input handler");
    },
    show: (id) => shownDownloads.push(id)
  },
  i18n: { getMessage: (key) => key },
  notifications: {
    create: async (id, notification) => notifications.push({ id, notification }),
    onClicked: { addListener: (listener) => notificationClickListeners.push(listener) }
  },
  permissions: { onAdded: event(), onRemoved: event() },
  runtime: {
    getManifest: () => ({ browser_specific_settings: { gecko: { id: "test" } } }),
    getURL: (path) => `moz-extension://test/${path}`,
    onInstalled: event(),
    onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
    onStartup: event(),
    sendMessage: async () => {
      runtimeMessages += 1;
      return { ok: true };
    }
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

// The background page prepares files itself, so it needs the same document and
// storage surface the offscreen document has under Chrome.
const removedFiles = [];
const fileChunks = [];
let drawnFrames = 0;
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    body: { append: () => {} },
    createElement: (tag) => {
      if (tag === "video") {
        return {
          duration: 8,
          videoHeight: 720,
          videoWidth: 1280,
          // Report success for the events a decodable file would fire, and never
          // for "error", which is how an undecodable slice is signalled.
          addEventListener(type, handler) {
            if (type === "loadeddata" || type === "seeked") queueMicrotask(handler);
          },
          load() {},
          removeAttribute() {}
        };
      }
      if (tag === "canvas") {
        return {
          getContext: () => ({ drawImage: () => { drawnFrames += 1; } }),
          toDataURL: () => "data:image/jpeg;base64,PREVIEW"
        };
      }
      return { click() {}, remove() {} };
    }
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
            write: async (chunk) => fileChunks.push(chunk)
          }),
          getFile: async () => new Blob(fileChunks)
        }),
        // Nothing stale to collect here; test-safari.mjs covers the sweep.
        keys: async function* () {},
        removeEntry: async (name) => removedFiles.push(name)
      })
    }
  }
});
globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), {
  headers: { "content-length": "4" }
});

// background.mjs is what these browsers actually load: it imports both halves
// and wires them to each other, which is what replaced the dynamic import a
// service worker was never allowed to make.
await import("./background.mjs");

assert.deepEqual(requestHeaderOptions, [["requestHeaders"]]);

downloadListeners[0]({ id: 21, state: { current: "complete" } });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(stored["download-job:finished"].state, "complete");
assert.equal(notifications.length, 1);
assert.equal(notifications[0].notification.buttons, undefined);
assert.equal(notifications[0].notification.contextMessage, undefined);
notificationClickListeners[0](notifications[0].id);
assert.deepEqual(shownDownloads, [21], "the click must reveal the file, not try to open it");

// A direct download end to end: the replay rule must be one Firefox accepts,
// and the response must not settle until the native transfer reports back.
const job = {
  id: "direct",
  item: {
    kind: "file",
    requestHeaders: [{ name: "referer", value: "https://video.example/watch" }],
    url: "https://cdn.example/video.mp4"
  },
  state: "queued"
};
stored[`download-job:${job.id}`] = job;
let directResponse;
runtimeListeners[0]({
  filename: "Firefox direct.mp4",
  job,
  target: "service-worker",
  type: "start-direct"
}, null, (response) => {
  directResponse = response;
});
await new Promise((resolve) => setTimeout(resolve, 50));

assert.equal(addedRules.length, 1, "Firefox rejected the replay rule outright");
assert.deepEqual(addedRules[0].condition, {
  isUrlFilterCaseSensitive: true,
  urlFilter: "|https://cdn.example/video.mp4|"
}, "Firefox has no tabIds condition, so the rule must not carry one");
assert.equal(sessionRules.length, 0, "the replay rule is removed once the transfer is done");
assert.equal(startedDownloads.at(-1).filename, "Firefox direct.mp4");
assert.equal(directResponse, undefined, "the background page stays alive during the native handoff");
downloadListeners[0]({ id: nextDownloadId, state: { current: "complete" } });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(directResponse.ok, true);
assert.equal(stored[`download-job:${job.id}`].state, "complete");
assert.deepEqual(removedFiles, [`downloadswift-${job.id}.mp4`]);

// An HLS job widens its rule to the segment hosts; requestDomains is supported,
// tabIds is not.
sessionRules.length = 0;
sessionRules.push({ id: 7 });
stored["download-job:hls"] = {
  id: "hls",
  item: {
    requestHeaders: [{ name: "referer", value: "https://video.example/watch" }],
    url: "https://playlist.example/master.m3u8"
  },
  ruleId: 7
};
const extended = await new Promise((resolve) => {
  runtimeListeners[0]({
    hosts: ["playlist.example", "segments.example"],
    jobId: "hls",
    target: "service-worker",
    type: "extend-headers"
  }, null, resolve);
});
assert.equal(extended.ok, true);
assert.deepEqual(sessionRules[0].condition, {
  requestDomains: ["playlist.example", "segments.example"]
});

// A completion that arrives before downloads.download() resolves must still
// finish the job rather than leaving it parked at 95%.
completeBeforeDownloadResolves = true;
fileChunks.length = 0;
removedFiles.length = 0;
const racing = {
  id: "racing",
  item: { kind: "file", requestHeaders: [], url: "https://cdn.example/racing.mp4" },
  state: "queued"
};
stored[`download-job:${racing.id}`] = racing;
// Raced against a timeout: a dropped completion never settles at all, which
// would otherwise end this run as a silent pending-promise exit.
const racingResponse = await Promise.race([
  new Promise((resolve) => {
    runtimeListeners[0]({
      filename: "Firefox racing.mp4",
      job: racing,
      target: "service-worker",
      type: "start-direct"
    }, null, resolve);
  }),
  new Promise((resolve) => setTimeout(() => resolve({ wedged: true }), 500))
]);
assert.ok(!racingResponse.wedged, "an early completion must not wedge the job");
assert.equal(racingResponse.ok, true);
assert.equal(stored[`download-job:${racing.id}`].state, "complete");
assert.deepEqual(removedFiles, [`downloadswift-${racing.id}.mp4`]);
completeBeforeDownloadResolves = false;

// A preview arms the same referer replay a download uses, but asks for only the
// opening slice. The frame itself is decoded in the popup, so this side is just
// the rule going up and coming back down.
addedRules.length = 0;
// The HLS block above deliberately leaves its widened rule in place.
sessionRules.length = 0;
const previewItem = {
  kind: "file",
  mime: "video/mp4",
  requestHeaders: [{ name: "referer", value: "https://video.example/watch" }],
  url: "https://cdn.example/preview.mp4"
};
const armed = await new Promise((resolve) => {
  runtimeListeners[0]({
    item: previewItem,
    target: "service-worker",
    type: "arm-preview"
  }, null, resolve);
});
assert.equal(armed.ok, true);
assert.deepEqual(addedRules[0].condition, {
  isUrlFilterCaseSensitive: true,
  urlFilter: `|${previewItem.url}|`
});
assert.deepEqual(
  addedRules[0].action.requestHeaders.map((header) => [header.header, header.value]),
  [["referer", "https://video.example/watch"], ["range", "bytes=0-2097151"]]
);
assert.equal(sessionRules.length, 1, "the rule stays up while the popup fetches");

const disarmed = await new Promise((resolve) => {
  runtimeListeners[0]({
    ruleId: armed.ruleId,
    target: "service-worker",
    type: "disarm-preview",
    url: previewItem.url
  }, null, resolve);
});
assert.equal(disarmed.ok, true);
assert.equal(sessionRules.length, 0, "the preview rule must not outlive the fetch");

// A stream is scoped by host rather than to one exact URL, because its playlist
// and its segments are separate requests.
addedRules.length = 0;
sessionRules.length = 0;
const streamItem = {
  kind: "playlist",
  requestHeaders: [{ name: "referer", value: "https://video.example/watch" }],
  url: "https://playlist.example/master.m3u8"
};
const armedStream = await new Promise((resolve) => {
  runtimeListeners[0]({ item: streamItem, target: "service-worker", type: "arm-preview" }, null, resolve);
});
assert.equal(armedStream.ok, true);
assert.deepEqual(addedRules[0].condition, { requestDomains: ["playlist.example"] });
// No opening-slice range for a stream: it is read a whole segment at a time.
assert.deepEqual(
  addedRules[0].action.requestHeaders.map((header) => header.header),
  ["referer"]
);

// Segments can live on another host, so the rule is widened once they are known.
addedRules.length = 0;
const widened = await new Promise((resolve) => {
  runtimeListeners[0]({
    hosts: ["playlist.example", "segments.example"],
    item: streamItem,
    target: "service-worker",
    type: "arm-preview"
  }, null, resolve);
});
assert.equal(widened.ok, true);
assert.deepEqual(addedRules[0].condition, {
  requestDomains: ["playlist.example", "segments.example"]
});
await new Promise((resolve) => {
  runtimeListeners[0]({ ruleId: widened.ruleId, target: "service-worker", type: "disarm-preview", url: streamItem.url }, null, resolve);
});
await new Promise((resolve) => {
  runtimeListeners[0]({ ruleId: armedStream.ruleId, target: "service-worker", type: "disarm-preview", url: streamItem.url }, null, resolve);
});

// An item already previewed costs nothing the second time around.
addedRules.length = 0;
stored[`preview:${previewItem.url}`] = "data:image/jpeg;base64,PREVIEW";
const repeat = await new Promise((resolve) => {
  runtimeListeners[0]({ item: previewItem, target: "service-worker", type: "arm-preview" }, null, resolve);
});
assert.equal(repeat.ok, false);
assert.deepEqual(addedRules, [], "a cached preview may not touch the rule set");

// Concurrent arming must not hand out the same rule id twice: the second
// updateSessionRules would be rejected for reusing it.
addedRules.length = 0;
const concurrent = await Promise.all(["a", "b", "c"].map((name) => new Promise((resolve) => {
  runtimeListeners[0]({
    item: { kind: "file", requestHeaders: [{ name: "referer", value: "https://v.example/" }], url: `https://cdn.example/${name}.mp4` },
    target: "service-worker",
    type: "arm-preview"
  }, null, resolve);
})));
assert.deepEqual(concurrent.map((result) => result.ok), [true, true, true]);
const ids = concurrent.map((result) => result.ruleId);
assert.equal(new Set(ids).size, 3, `concurrent rule ids must be unique, got ${ids}`);

stored["download-job:cancel"] = { id: "cancel", state: "downloading" };
const response = await new Promise((resolve) => {
  runtimeListeners[0]({
    jobId: "cancel",
    target: "service-worker",
    type: "cancel-download"
  }, null, resolve);
});
assert.equal(response.ok, true);
assert.equal(stored["download-job:cancel"].state, "canceled");
assert.equal(runtimeMessages, 0, "Firefox background-page messages stay in the same page");

console.log("Firefox compatibility check passed");
