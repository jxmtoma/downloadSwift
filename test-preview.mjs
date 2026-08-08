import assert from "node:assert/strict";
import { firstFrameDataUrl, makePreview } from "./preview.mjs";

let drawn = null;
let seekedTo = null;

// Stands in for a decodable file: fires the events a real element fires, and
// never "error", which is how an undecodable slice reports itself.
const videoElement = (overrides = {}) => ({
  duration: 8,
  videoHeight: 720,
  videoWidth: 1280,
  addEventListener(type, handler) {
    if (type === "loadeddata" || type === "seeked") queueMicrotask(handler);
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
assert.equal(
  (await makePreview({ url: "https://cdn.example/a.mp4" }, {
    createElement: createElement(videoElement()),
    fetchBytes: async () => blob
  })).dataUrl,
  "data:image/jpeg;base64,FRAME"
);

console.log("preview frame check passed");
