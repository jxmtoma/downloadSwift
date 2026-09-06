import assert from "node:assert/strict";
import fs from "node:fs";
import { boxes, findBox } from "./mp4.mjs";

const stored = {};
const runtimeListeners = [];
const downloadListeners = [];
const headersReceivedListeners = [];
const permissionListeners = [];
const tabRemovedListeners = [];
const tabUpdatedListeners = [];
const sessionRules = [];
const sentMessages = [];
const notifications = [];
const notificationButtonListeners = [];
const openedDownloads = [];
const shownDownloads = [];
const uiStates = [];
let options;

// Chrome defines a `browser` alias of its own now, so its presence says nothing
// about which background context this is. Mirroring that here keeps the worker
// on the offscreen path: taking the background-page path instead reaches a
// dynamic import, which a service worker is forbidden to make.
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
    onUpdated: { addListener: (listener) => tabUpdatedListeners.push(listener) }
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

globalThis.browser = globalThis.chrome;
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

// Players fetch the master before its variants. When both use anonymous names
// in the same directory, keep that first request so its quality list survives.
for (const url of [
  "https://cdn.example/anonymous/index.m3u8",
  "https://cdn.example/anonymous/video.m3u8"
]) {
  headersReceivedListeners[0]({
    requestId: `anonymous:${url}`,
    responseHeaders: [],
    statusCode: 200,
    tabId: 14,
    type: "xmlhttprequest",
    url
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.deepEqual(stored["media:14"].map((item) => item.url), [
  "https://cdn.example/anonymous/index.m3u8"
]);

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

stored["media:15"] = [{ url: "https://cdn.example/kept.m3u8" }];
tabUpdatedListeners[0](15, { status: "loading" }, { url: "https://video.example/embed" });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(stored["media:15"].length, 1, "a same-URL player reload keeps detected media");
tabUpdatedListeners[0](15, { status: "loading", url: "https://video.example/next" }, {
  url: "https://video.example/next"
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(stored["media:15"], undefined, "a real navigation clears the previous page's media");

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
// Keyed by name and honouring a position, the way storage that supports the
// positioned write behaves. The capability probe writes its own scratch file, so
// a single shared buffer would mix the probe's bytes into the download's.
const filesByName = new Map();
const bytesFor = (name) => {
  if (!filesByName.has(name)) filesByName.set(name, { bytes: new Uint8Array(0), cursor: 0 });
  return filesByName.get(name);
};
const writeInto = (file, data, position) => {
  const end = position + data.length;
  if (end > file.bytes.length) {
    const grown = new Uint8Array(end);
    grown.set(file.bytes);
    file.bytes = grown;
  }
  file.bytes.set(data, position);
  file.cursor = Math.max(file.cursor, end);
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    storage: {
      getDirectory: async () => ({
        getFileHandle: async (name) => ({
          createWritable: async () => {
            const file = bytesFor(name);
            file.bytes = new Uint8Array(0);
            file.cursor = 0;
            return {
              abort: async () => {},
              close: async () => {},
              write: async (chunk) => {
                const positioned = Boolean(chunk && chunk.type === "write");
                const data = new Uint8Array(positioned ? chunk.data : chunk);
                writeInto(file, data, positioned ? chunk.position : file.cursor);
                // The ordering assertions below read the media as it was handed over.
                if (!positioned && name.endsWith(".mp4")) fileChunks.push(chunk);
              }
            };
          },
          getFile: async () => {
            stagedFile = new Blob([bytesFor(name).bytes]);
            return stagedFile;
          }
        }),
        // Nothing stale to collect here; test-safari.mjs covers the sweep.
        keys: async function* () {},
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
    filename: "Renamed clip.mp4",
    id: "offscreen-hls",
    item: { format: "HLS", kind: "playlist", url: "https://cdn.example/720p.m3u8" },
    pageTitle: "Page title",
    tabId: 5
  },
  target: "offscreen",
  type: "start-hls"
}, null, () => {});
const hlsReady = await hlsPrepared;
assert.equal(hlsReady.filename, "Renamed clip.mp4");

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

// The highest-risk 0.5 path crosses variant selection, a separate HLS audio
// playlist, two-track fragment merging, and progressive MP4 finalization. The
// parser and MP4 builder have focused checks; this keeps their seam covered too.
const fixture = (name) => new Uint8Array(fs.readFileSync(`test-fixtures/dash/${name}`));
const splitMaster = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="English",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="stereo"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="stereo"
high/index.m3u8`;
const splitVideo = `#EXTM3U
#EXT-X-MAP:URI="init.m4s"
#EXTINF:8.933333,
video-1.m4s
#EXT-X-ENDLIST`;
const splitAudio = `#EXTM3U
#EXT-X-MAP:URI="init.m4s"
#EXTINF:8.933333,
audio-1.m4s
#EXT-X-ENDLIST`;
const splitResponses = new Map([
  ["https://cdn.example/master.m3u8", splitMaster],
  ["https://cdn.example/low/index.m3u8", splitVideo],
  ["https://cdn.example/high/index.m3u8", splitVideo],
  ["https://cdn.example/audio/index.m3u8", splitAudio],
  ["https://cdn.example/low/init.m4s", fixture("video-init.m4s")],
  ["https://cdn.example/low/video-1.m4s", fixture("video-1.m4s")],
  ["https://cdn.example/audio/init.m4s", fixture("audio-init.m4s")],
  ["https://cdn.example/audio/audio-1.m4s", fixture("audio-1.m4s")]
]);
const splitRequests = [];
globalThis.fetch = async (url) => {
  splitRequests.push(url);
  const body = splitResponses.get(url);
  return body == null ? new Response(null, { status: 404 }) : new Response(body);
};

const splitPrepared = new Promise((resolve) => {
  resolvePrepared = resolve;
});
runtimeListeners[1]({
  job: {
    filename: "Selected quality.mp4",
    id: "offscreen-split-hls",
    item: {
      format: "HLS",
      kind: "playlist",
      url: "https://cdn.example/master.m3u8",
      variantUrl: "https://cdn.example/low/index.m3u8"
    },
    pageTitle: "Page title",
    tabId: 5
  },
  target: "offscreen",
  type: "start-hls"
}, null, () => {});
const splitReady = await splitPrepared;
assert.equal(splitReady.filename, "Selected quality.mp4");
assert.ok(splitRequests.includes("https://cdn.example/low/video-1.m4s"));
assert.ok(!splitRequests.some((url) => url.includes("/high/")), "only the selected quality is fetched");

const splitBytes = new Uint8Array(await stagedFile.arrayBuffer());
assert.deepEqual([...boxes(splitBytes)].map((box) => box.type), ["ftyp", "mdat", "moov"]);
const moov = findBox(splitBytes, ["moov"]);
const tracks = [...boxes(splitBytes, moov.body, moov.end)].filter((box) => box.type === "trak");
assert.equal(tracks.length, 2, "the finished MP4 declares video and audio tracks");
assert.deepEqual(tracks.map((track) => {
  const hdlr = findBox(splitBytes, ["mdia", "hdlr"], track.body, track.end);
  return String.fromCharCode(...splitBytes.subarray(hdlr.body + 8, hdlr.body + 12));
}), ["vide", "soun"]);
for (const track of tracks) {
  const sizes = findBox(splitBytes, ["mdia", "minf", "stbl", "stsz"], track.body, track.end);
  assert.ok(new DataView(splitBytes.buffer, splitBytes.byteOffset, splitBytes.byteLength)
    .getUint32(sizes.body + 8) > 0, "each track has samples");
}

// A stream with a subtitle rendition gets a sidecar .vtt written next to the
// video: the segments are fetched, joined onto one timeline, and offered to the
// worker as a plain download that job completion ignores.
const preparedWaiters = new Map();
const waitFor = (jobId, type) => new Promise((resolve) => {
  preparedWaiters.set(`${jobId}:${type}`, resolve);
});
chrome.runtime.sendMessage = async (message) => {
  sentMessages.push(message);
  preparedWaiters.get(`${message.jobId}:${message.type}`)?.(message);
  return { ok: true };
};

const subtitledPlaylist = [
  "#EXTM3U",
  "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",DEFAULT=YES,URI=\"subs.m3u8\"",
  "#EXT-X-STREAM-INF:BANDWIDTH=2400000,SUBTITLES=\"subs\"",
  "subs-video.m3u8"
].join("\n");
const vttSegments = [
  "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nOne",
  "WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nTwo"
];
globalThis.fetch = async (url) => {
  if (url.endsWith("subs-master.m3u8")) return new Response(subtitledPlaylist);
  if (url.endsWith("subs-video.m3u8")) {
    return new Response("#EXTM3U\n#EXTINF:4,\nseg0.m4s\n#EXT-X-ENDLIST");
  }
  if (url.endsWith("subs.m3u8")) {
    return new Response("#EXTM3U\n#EXTINF:4,\nsub0.vtt\n#EXTINF:4,\nsub1.vtt\n#EXT-X-ENDLIST");
  }
  if (url.endsWith(".vtt")) {
    return new Response(vttSegments[Number(url.match(/sub(\d+)\.vtt/)[1])]);
  }
  return new Response(new Uint8Array([9]));
};

runtimeListeners[1]({
  job: {
    filename: "Subtitled video.mp4",
    id: "offscreen-subtitles",
    item: { format: "HLS", kind: "playlist", url: "https://cdn.example/subs-master.m3u8" },
    pageTitle: "Subtitled video",
    tabId: 5
  },
  target: "offscreen",
  type: "start-hls"
}, null, () => {});
const sidecarMessage = await waitFor("offscreen-subtitles", "sidecar-ready");

assert.equal(sidecarMessage.filename, "Subtitled video.vtt");
assert.equal(sidecarMessage.type, "sidecar-ready");
assert.equal(new TextDecoder().decode(bytesFor("downloadswift-offscreen-subtitles.vtt").bytes), [
  "WEBVTT",
  "",
  "00:00:00.000 --> 00:00:02.000",
  "One",
  "",
  "00:00:06.000 --> 00:00:08.000",
  "Two",
  ""
].join("\n"));
assert.equal(
  sentMessages.find((message) => message.type === "hls-progress"
    && message.jobId === "offscreen-subtitles"
    && message.changes.subtitleTempName).changes.subtitleFilename,
  "Subtitled video.vtt",
  "Safari reads the sidecar's name out of the job"
);

// Audio-only skips the video merge and writes the audio track as .m4a.
globalThis.fetch = async (url) => {
  if (url.endsWith("audio-master.m3u8")) {
    return new Response([
      "#EXTM3U",
      "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"English\",DEFAULT=YES,URI=\"audio.m3u8\"",
      "#EXT-X-STREAM-INF:BANDWIDTH=2400000,AUDIO=\"a\"",
      "video.m3u8"
    ].join("\n"));
  }
  if (url.endsWith("audio.m3u8")) {
    // No init segment: the raw bytes pass through to the .m4a untouched.
    return new Response("#EXTM3U\n#EXTINF:4,\naudio-0.mp4\n#EXT-X-ENDLIST");
  }
  return new Response(new Uint8Array([7, 7]));
};

runtimeListeners[1]({
  job: {
    filename: "Audio only.mp4",
    id: "offscreen-audio",
    item: {
      audioOnly: true,
      format: "HLS",
      kind: "playlist",
      url: "https://cdn.example/audio-master.m3u8"
    },
    pageTitle: "Audio only",
    tabId: 5
  },
  target: "offscreen",
  type: "start-hls"
}, null, () => {});
const audioMessage = await waitFor("offscreen-audio", "download-ready");

assert.equal(audioMessage.filename, "Audio only.m4a");
assert.deepEqual(
  [...bytesFor("downloadswift-offscreen-audio.m4a").bytes],
  [7, 7],
  "the .m4a holds the audio rendition's bytes, not the video's"
);

// Byte-range HLS: every segment is a slice of one resource, fetched with its
// exact Range header, and the slices land in playlist order in the file.
const rangeResource = new Uint8Array(1000).map((_, index) => index % 251);
const rangePlaylist = [
  "#EXTM3U",
  "#EXTINF:4,",
  "#EXT-X-BYTERANGE:100@200",
  "range-seg-0.mp4",
  "#EXTINF:4,",
  "#EXT-X-BYTERANGE:100",
  "range-seg-1.mp4",
  "#EXT-X-ENDLIST"
].join("\n");
const rangeRequests = [];
globalThis.fetch = async (url, options = {}) => {
  if (url.endsWith("range.m3u8")) return new Response(rangePlaylist);
  rangeRequests.push({ range: options.headers?.Range, url });
  const match = /bytes=(\d+)-(\d+)/.exec(options.headers?.Range ?? "");
  if (match) {
    const start = Number(match[1]);
    return new Response(rangeResource.slice(start, Number(match[2]) + 1));
  }
  return new Response(rangeResource);
};

runtimeListeners[1]({
  job: {
    filename: "Byte range.mp4",
    id: "offscreen-range",
    item: { format: "HLS", kind: "playlist", url: "https://cdn.example/range.m3u8" },
    pageTitle: "Byte range",
    tabId: 5
  },
  target: "offscreen",
  type: "start-hls"
}, null, () => {});
const rangeMessage = await waitFor("offscreen-range", "download-ready");

assert.equal(rangeMessage.filename, "Byte range.mp4");
// The first range is explicit; the second chains implicitly from its end.
assert.deepEqual(rangeRequests.map((request) => request.range), [
  "bytes=200-299",
  "bytes=300-399"
]);
assert.deepEqual(
  [...bytesFor("downloadswift-offscreen-range.mp4").bytes],
  [...rangeResource.slice(200, 300), ...rangeResource.slice(300, 400)]
);

// A sidecar download's completion must not touch the job machinery.
const sidecarDownloadResponse = await new Promise((resolve) => {
  runtimeListeners[0]({
    filename: "Subtitled video.vtt",
    jobId: "any",
    target: "service-worker",
    type: "sidecar-ready",
    url: "blob:chrome-extension://test/subs"
  }, null, resolve);
});
assert.equal(sidecarDownloadResponse.ok, true);
assert.deepEqual(options, {
  conflictAction: "uniquify",
  filename: "Subtitled video.vtt",
  saveAs: false,
  url: "blob:chrome-extension://test/subs"
});
options = undefined;
downloadListeners[0]({ id: 8, state: { current: "complete" } });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(options, undefined, "a sidecar completion is not stashed for a job mapping");

console.log("managed and direct download flow check passed");
