import assert from "node:assert/strict";

const stored = {};
const runtimeListeners = [];
const downloadListeners = [];
const headersReceivedListeners = [];
const tabRemovedListeners = [];
const sessionRules = [];
const sentMessages = [];
const notifications = [];
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
    setUiOptions: async ({ enabled }) => uiStates.push(enabled)
  },
  notifications: {
    create: async (id, notification) => notifications.push({ id, notification })
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
    onBeforeSendHeaders: { addListener: () => {} },
    onCompleted: { addListener: () => {} },
    onErrorOccurred: { addListener: () => {} },
    onHeadersReceived: { addListener: (listener) => headersReceivedListeners.push(listener) }
  }
};

await import("./service-worker.mjs");

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

console.log("managed and direct download flow check passed");
