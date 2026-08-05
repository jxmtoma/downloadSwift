import assert from "node:assert/strict";

const stored = {};
const runtimeListeners = [];
const downloadListeners = [];
const headersReceivedListeners = [];
const permissionListeners = [];
const tabRemovedListeners = [];
const sessionRules = [];
const sentMessages = [];
const notifications = [];
const notificationButtonListeners = [];
const openedDownloads = [];
const shownDownloads = [];
const uiStates = [];
let options;

globalThis.chrome = {
  action: { setBadgeText: async () => {} },
  declarativeNetRequest: {
    getSessionRules: async () => sessionRules,
    updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => {
      sessionRules.push(...addRules);
      for (const id of removeRuleIds) {
        const index = sessionRules.findIndex((rule) => rule.id === id);
        if (index >= 0) sessionRules.splice(index, 1);
      }
    }
  },
  downloads: {
    cancel: async () => {},
    download: async (value) => {
      options = value;
      return 7;
    },
    onChanged: { addListener: (listener) => downloadListeners.push(listener) },
    open: (id) => openedDownloads.push(id),
    setUiOptions: async ({ enabled }) => uiStates.push(enabled),
    show: (id) => shownDownloads.push(id)
  },
  notifications: {
    create: async (id, notification) => notifications.push({ id, notification }),
    onButtonClicked: { addListener: (listener) => notificationButtonListeners.push(listener) }
  },
  offscreen: { createDocument: async () => {} },
  runtime: {
    getContexts: async () => [],
    getURL: (path) => `chrome-extension://test/${path}`,
    onInstalled: { addListener: () => {} },
    onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
    onStartup: { addListener: () => {} },
    sendMessage: async (message) => {
      sentMessages.push(message);
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
  tabs: {
    onRemoved: { addListener: (listener) => tabRemovedListeners.push(listener) },
    onUpdated: { addListener: () => {} }
  },
  webRequest: {
    onBeforeSendHeaders: { addListener: () => {}, removeListener: () => {} },
    onCompleted: { addListener: () => {}, removeListener: () => {} },
    onErrorOccurred: { addListener: () => {}, removeListener: () => {} },
    onHeadersReceived: {
      addListener: (listener) => headersReceivedListeners.push(listener),
      removeListener: (listener) => {
        const index = headersReceivedListeners.indexOf(listener);
        if (index >= 0) headersReceivedListeners.splice(index, 1);
      }
    }
  }
};
chrome.permissions = {
  onAdded: { addListener: (listener) => permissionListeners.push(listener) },
  onRemoved: { addListener: (listener) => permissionListeners.push(listener) }
};

await import("./service-worker.mjs");

// Granting or revoking host access must rebind the webRequest listeners, since
// webRequest captured the permission set it had when they were first added.
assert.equal(headersReceivedListeners.length, 1);
assert.equal(permissionListeners.length, 2, "both permissions.onAdded and onRemoved");
const [onPermissionAdded] = permissionListeners;
const originalListener = headersReceivedListeners[0];
onPermissionAdded();
assert.equal(headersReceivedListeners.length, 1, "re-registered, not double-registered");
assert.notEqual(headersReceivedListeners[0], undefined);
assert.equal(headersReceivedListeners[0], originalListener);

for (const url of [
  "https://cdn.example/master.m3u8",
  "https://cdn.example/720p.m3u8"
]) {
  headersReceivedListeners[0]({
    requestId: url,
    responseHeaders: [],
    statusCode: 200,
    tabId: 9,
    type: "xmlhttprequest",
    url
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.equal(stored["media:9"].length, 1);
assert.equal(stored["media:9"][0].name, "master.m3u8");

for (const url of [
  "https://cdn.example/720p.m3u8",
  "https://cdn.example/master.m3u8"
]) {
  headersReceivedListeners[0]({
    requestId: `reverse:${url}`,
    responseHeaders: [],
    statusCode: 200,
    tabId: 10,
    type: "xmlhttprequest",
    url
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.equal(stored["media:10"].length, 1);
assert.equal(stored["media:10"][0].name, "master.m3u8");

// Two embedded players are two streams: their directories do not nest, so each
// keeps an entry, while a variant below a master still collapses into it.
for (const url of [
  "https://cdn.example/hls/first/master.m3u8",
  "https://cdn.example/hls/first/720p/index.m3u8",
  "https://cdn.example/hls/second/master.m3u8"
]) {
  headersReceivedListeners[0]({
    requestId: `multi:${url}`,
    responseHeaders: [],
    statusCode: 200,
    tabId: 12,
    type: "xmlhttprequest",
    url
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.deepEqual(stored["media:12"].map((item) => item.url), [
  "https://cdn.example/hls/second/master.m3u8",
  "https://cdn.example/hls/first/master.m3u8"
]);

// fMP4 segments are video/mp4 files by every test a single response can make, so
// they are ruled out by where they sit and by nobody playing them directly.
for (const [type, url] of [
  ["xmlhttprequest", "https://cdn.example/vod/fmp4/index.m3u8"],
  ["xmlhttprequest", "https://cdn.example/vod/fmp4/init.mp4"],
  ["xmlhttprequest", "https://cdn.example/vod/fmp4/seg1.mp4"],
  ["xmlhttprequest", "https://cdn.example/media/other.mp4"],
  ["media", "https://cdn.example/vod/fmp4/preview.mp4"]
]) {
  headersReceivedListeners[0]({
    requestId: `fmp4:${url}`,
    responseHeaders: [],
    statusCode: 200,
    tabId: 13,
    type,
    url
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.deepEqual(stored["media:13"].map((item) => item.url), [
  "https://cdn.example/vod/fmp4/preview.mp4",
  "https://cdn.example/media/other.mp4",
  "https://cdn.example/vod/fmp4/index.m3u8"
]);

// A service-worker restart loses the captured request context, so the page origin
// stands in for the referer most media hosts check.
headersReceivedListeners[0]({
  initiator: "https://video.example",
  requestId: "restart:1",
  responseHeaders: [],
  statusCode: 200,
  tabId: 11,
  type: "xmlhttprequest",
  url: "https://cdn.example/restart.m3u8"
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(stored["media:11"][0].requestHeaders, [
  { name: "referer", value: "https://video.example/" }
]);

// Re-detecting the same URL without a context keeps the headers already captured.
headersReceivedListeners[0]({
  requestId: "restart:2",
  responseHeaders: [],
  statusCode: 200,
  tabId: 11,
  type: "xmlhttprequest",
  url: "https://cdn.example/restart.m3u8"
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(stored["media:11"].length, 1);
assert.deepEqual(stored["media:11"][0].requestHeaders, [
  { name: "referer", value: "https://video.example/" }
]);

const job = {
  id: "direct",
  item: {
    kind: "file",
    requestHeaders: [{ name: "referer", value: "https://video.example/watch/1" }],
    url: "https://cdn.example/video.mp4"
  },
  tabId: 5,
  state: "queued"
};
stored["download-job:direct"] = job;
stored["media:5"] = [job.item];

const response = await new Promise((resolve) => {
  runtimeListeners[0]({
    filename: "Page title.mp4",
    job,
    target: "service-worker",
    type: "start-direct"
  }, null, resolve);
});

assert.equal(response.ok, true);
assert.equal(options, undefined);
assert.equal(sentMessages.at(-1).type, "start-direct");
assert.equal(sentMessages.at(-1).target, "offscreen");
assert.equal(sessionRules[0].action.requestHeaders[0].header, "referer");
// Exact-URL match, scoped to the extension's own fetches (tabId -1), no regex.
assert.deepEqual(sessionRules[0].condition, {
  isUrlFilterCaseSensitive: true,
  tabIds: [-1],
  urlFilter: "|https://cdn.example/video.mp4|"
});
assert.deepEqual(sessionRules[0].action.requestHeaders[1], {
  header: "range",
  operation: "set",
  value: "bytes=0-"
});
assert.equal(stored["download-job:direct"].state, "preparing");

tabRemovedListeners[0](5);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(stored["media:5"], undefined);
assert.equal(stored["download-job:direct"].state, "preparing");

const readyResponse = await new Promise((resolve) => {
  runtimeListeners[0]({
    filename: "Page title.mp4",
    jobId: job.id,
    target: "service-worker",
    type: "download-ready",
    url: "blob:chrome-extension://test/video"
  }, null, resolve);
});

assert.equal(readyResponse.ok, true);
assert.deepEqual(options, {
  filename: "Page title.mp4",
  saveAs: false,
  url: "blob:chrome-extension://test/video"
});
assert.equal(uiStates[0], false);
assert.equal(stored["download-job:direct"].state, "downloading");
assert.equal(sessionRules.length, 0);

downloadListeners[0]({ id: 7, state: { current: "complete" } });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(stored["download-job:direct"].state, "complete");
assert.equal(sessionRules.length, 0);
assert.equal(uiStates.at(-1), true);
assert.equal(notifications[0].notification.message, "Page title.mp4");
assert.deepEqual(notifications[0].notification.buttons, [
  { title: "open_file" },
  { title: "show_in_folder" }
]);
notificationButtonListeners[0](notifications[0].id, 0);
notificationButtonListeners[0](notifications[0].id, 1);
assert.deepEqual(openedDownloads, [7]);
assert.deepEqual(shownDownloads, [7]);

const hlsJob = {
  id: "hls",
  item: {
    format: "HLS",
    kind: "playlist",
    requestHeaders: [{ name: "referer", value: "https://video.example/watch/1" }],
    url: "https://cdn.example/hls/master.m3u8"
  },
  state: "queued",
  tabId: 6
};
stored["download-job:hls"] = hlsJob;

const hlsResponse = await new Promise((resolve) => {
  runtimeListeners[0]({ job: hlsJob, target: "service-worker", type: "start-hls" }, null, resolve);
});

// Streams replay the page referer too, or hotlink-protected hosts answer 403.
// Segment URLs are unknown until the playlist is parsed, so the rule starts
// scoped to the playlist's host.
assert.equal(hlsResponse.ok, true);
assert.equal(sessionRules.length, 1);
assert.deepEqual(sessionRules[0].condition, {
  requestDomains: ["cdn.example"],
  tabIds: [-1]
});
assert.deepEqual(sessionRules[0].action.requestHeaders, [
  { header: "referer", operation: "set", value: "https://video.example/watch/1" }
]);
assert.equal(stored["download-job:hls"].ruleId, sessionRules[0].id);

await new Promise((resolve) => {
  runtimeListeners[0]({
    hosts: ["cdn.example", "segments.example"],
    jobId: "hls",
    target: "service-worker",
    type: "extend-headers"
  }, null, resolve);
});

assert.equal(sessionRules.length, 1, "the widened rule replaces the original");
assert.deepEqual(sessionRules[0].condition.requestDomains, ["cdn.example", "segments.example"]);
assert.equal(stored["download-job:hls"].ruleId, sessionRules[0].id);

await new Promise((resolve) => {
  runtimeListeners[0]({
    jobId: "hls",
    target: "service-worker",
    type: "cancel-download"
  }, null, resolve);
});
assert.equal(sessionRules.length, 0, "canceling a stream drops its header rule");

let stagedFile;
let resolvePrepared;
const prepared = new Promise((resolve) => {
  resolvePrepared = resolve;
});
const fileChunks = [];
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
          getFile: async () => {
            stagedFile = new Blob(fileChunks);
            return stagedFile;
          }
        }),
        removeEntry: async () => {}
      })
    }
  }
});
globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), {
  headers: { "content-length": "4" }
});
chrome.runtime.sendMessage = async (message) => {
  sentMessages.push(message);
  if (message.type === "download-ready") resolvePrepared(message);
  return { ok: true };
};

await import("./offscreen.js");
runtimeListeners[1]({
  filename: "Page title.mp4",
  job: { ...job, id: "offscreen-direct" },
  target: "offscreen",
  type: "start-direct"
}, null, () => {});
const preparedMessage = await prepared;

assert.equal(preparedMessage.filename, "Page title.mp4");
assert.deepEqual([...new Uint8Array(await stagedFile.arrayBuffer())], [1, 2, 3, 4]);

const SEGMENT_COUNT = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const playlist = [
  "#EXTM3U",
  ...Array.from({ length: SEGMENT_COUNT }, (_, index) => `#EXTINF:4,\nseg${index}.m4s`),
  "#EXT-X-ENDLIST"
].join("\n");
const segmentRequests = [];
let inFlight = 0;
let peakInFlight = 0;
let failSegment3 = true;

globalThis.fetch = async (url) => {
  if (url.endsWith(".m3u8")) return new Response(playlist);

  segmentRequests.push(url);
  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  await sleep(1);
  inFlight -= 1;

  if (url.endsWith("seg3.m4s") && failSegment3) {
    failSegment3 = false;
    return new Response(null, { status: 503 });
  }
  return new Response(new Uint8Array([Number(url.match(/seg(\d+)\./)[1])]));
};

fileChunks.length = 0;
const hlsPrepared = new Promise((resolve) => {
  resolvePrepared = resolve;
});
runtimeListeners[1]({
  job: {
    id: "offscreen-hls",
    item: { format: "HLS", kind: "playlist", url: "https://cdn.example/720p.m3u8" },
    pageTitle: "Page title",
    tabId: 5
  },
  target: "offscreen",
  type: "start-hls"
}, null, () => {});
await hlsPrepared;

// The parsed playlist tells the worker which hosts the segments come from.
assert.deepEqual(
  sentMessages.find((message) => message.type === "extend-headers").hosts,
  ["cdn.example"]
);
// Segments land in playlist order even though they are fetched concurrently.
assert.deepEqual(
  [...new Uint8Array(await stagedFile.arrayBuffer())],
  Array.from({ length: SEGMENT_COUNT }, (_, index) => index)
);
assert.equal(peakInFlight, 4, "segments should be prefetched, not fetched one at a time");
// The 503 on seg3 is retried rather than failing the whole job.
assert.equal(segmentRequests.filter((url) => url.endsWith("seg3.m4s")).length, 2);

const hlsReports = sentMessages.filter((message) => (
  message.type === "hls-progress" && message.jobId === "offscreen-hls"
));
assert.equal(hlsReports.at(-1).changes.state, "saving");
// One report per distinct percentage bucket (0..90), not one per segment.
assert.equal(
  hlsReports.filter((message) => message.changes.state === "downloading").length,
  91,
  "progress reports must be throttled to percentage changes, not one per segment"
);
assert.ok(hlsReports.some((message) => Number.isFinite(
  Date.parse(message.changes.estimatedEndTime)
)), "stream progress includes an estimated completion time");

console.log("managed and direct download flow check passed");
