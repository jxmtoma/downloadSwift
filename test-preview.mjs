import assert from "node:assert/strict";
import { firstFrameDataUrl, makePreview, queueForItem, videoDimensions } from "./preview.mjs";

let drawn = null;
let seekedTo = null;

// Stands in for a decodable file: fires the events a real element fires, and
// never "error", which is how an undecodable slice reports itself.
const videoElement = (overrides = {}) => ({
  duration: 8,
  videoHeight: 720,
  videoWidth: 1280,
  addEventListener(type, handler) {
    if (type === "loadeddata" || type === "loadedmetadata" || type === "seeked") queueMicrotask(handler);
  },
  load() {},
  removeAttribute() {},
  set currentTime(value) { seekedTo = value; },
  ...overrides
});

const createElement = (element) => (tag) => {
  if (tag === "video") return element;
  return {
    getContext: () => ({
      drawImage: (_source, _x, _y, width, height) => { drawn = { height, width }; }
    }),
    set height(value) { this._height = value; },
    get height() { return this._height; },
    toDataURL: () => "data:image/jpeg;base64,FRAME",
    set width(value) { this._width = value; },
    get width() { return this._width; }
  };
};

const blob = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "video/mp4" });

const dataUrl = await firstFrameDataUrl(blob, createElement(videoElement()));
assert.equal(dataUrl, "data:image/jpeg;base64,FRAME");
// A quarter second in, because opening frames are routinely a black fade-in.
assert.equal(seekedTo, 1);
// 160 wide, and the source aspect ratio preserved rather than assumed 16:9.
assert.deepEqual(drawn, { height: 90, width: 160 });
assert.deepEqual(
  await videoDimensions("https://cdn.example/video.mp4", createElement(videoElement())),
  { height: 720, width: 1280 }
);

// A portrait clip keeps its shape.
drawn = null;
await firstFrameDataUrl(blob, createElement(videoElement({ videoHeight: 1280, videoWidth: 720 })));
assert.deepEqual(drawn, { height: 284, width: 160 });

// An audio-only or headerless file reports no dimensions; drawing it would
// produce a blank tile, so it must fail instead.
await assert.rejects(
  () => firstFrameDataUrl(blob, createElement(videoElement({ videoHeight: 0, videoWidth: 0 }))),
  /no video track/
);

// A file that never fires loadeddata must not hang the queue behind it.
const stalled = videoElement({ addEventListener() {} });
const started = Date.now();
await assert.rejects(() => firstFrameDataUrl(blob, createElement(stalled)), /decode timeout/);
assert.ok(Date.now() - started < 20000, "the decode timeout has to actually fire");

// makePreview swallows every failure: a missing thumbnail costs nothing, but a
// thrown one would surface as an error for a download nobody asked for.
assert.deepEqual(
  await makePreview({ url: "http://cdn.example/a.mp4" }, { createElement: createElement(videoElement()), fetchBytes: async () => blob }),
  { ok: false },
  "plain HTTP is refused the same as everywhere else"
);
assert.deepEqual(
  await makePreview({ url: "https://cdn.example/a.mp4" }, { createElement: createElement(videoElement()), fetchBytes: async () => null }),
  { ok: false }
);
assert.deepEqual(
  await makePreview({ url: "https://cdn.example/a.mp4" }, {
    createElement: createElement(videoElement()),
    fetchBytes: async () => { throw new Error("403"); }
  }),
  { ok: false }
);
assert.deepEqual(
  await makePreview({ url: "https://cdn.example/a.mp4" }, {
    createElement: createElement(videoElement()),
    fetchBytes: async () => blob
  }),
  { dataUrl: "data:image/jpeg;base64,FRAME", height: 720, ok: true, width: 1280 }
);

// The popup asks for three things per row — variants, size, thumbnail — and all
// three arm one redirect rule keyed by the row's URL. Two of them armed at once
// means one loses the rule and comes back empty, with nothing to show for it, so
// a row's own work has to stay in single file. Rows are independent of each
// other, though, and running them one at a time made the last row wait on every
// row above it: a thumbnail pulls a whole segment and decodes a frame from it.
//
// Five rows over three lanes, and one row far slower than the rest, both on
// purpose. With a multiple of the lane count, or with every task costing the
// same, a scheduler that hands out lanes per call rather than per row still
// happens to keep each row's work together and the race this exists to catch
// never shows. Uneven lanes running at uneven speeds are the real conditions:
// one row's frame decode stalling for eight seconds is the ordinary case.
let running = 0;
let peak = 0;
const inFlight = new Map();
const order = [];
// Recorded rather than asserted on the spot: the popup ignores what these
// return, so an assertion thrown in here lands in the same catch the real
// failures do and is never seen again.
let racedItself = null;

const task = (url, label, ms) => queueForItem(url, async () => {
  running += 1;
  peak = Math.max(peak, running);
  if (inFlight.get(url)) racedItself = url;
  inFlight.set(url, 1);
  order.push(label);
  await new Promise((resolve) => { setTimeout(resolve, ms); });
  inFlight.set(url, 0);
  running -= 1;
  // One row failing must not wedge the lane the rows behind it are waiting in.
  if (label === "thumbnail-a") throw new Error("undecodable");
}).catch(() => {});

const rows = ["a", "b", "c", "d", "e"];
const passes = ["variants", "size", "thumbnail"];
const cost = (pass, url) => (
  url === "a" && pass === "variants" ? 60 : pass === "thumbnail" ? 20 : 10
);
await Promise.all(passes.flatMap((pass) => rows.map(
  (url) => task(url, `${pass}-${url}`, cost(pass, url))
)));

assert.equal(racedItself, null, `${racedItself} armed two of its own requests at once`);
assert.equal(peak, 3, "rows run a few at a time, not one at a time and not all at once");
assert.equal(order.length, rows.length * passes.length,
  "a failed task must not strand the ones queued behind it");
// A row's own three keep the order they were asked in, which is what lets the
// list show a size long before it can show a picture.
for (const url of rows) {
  assert.deepEqual(
    order.filter((label) => label.endsWith(`-${url}`)),
    passes.map((pass) => `${pass}-${url}`),
    `${url} ran its own work out of order`
  );
}

console.log("preview frame check passed");
