import assert from "node:assert/strict";
import { detectMedia, downloadFilename, isSecureMediaUrl } from "./media.mjs";

const header = (value) => [{ name: "Content-Type", value }];

assert.equal(detectMedia({ url: "https://cdn.example/video.mp4" }).kind, "file");
assert.equal(detectMedia({ url: "http://cdn.example/video.mp4" }), null);
assert.equal(isSecureMediaUrl("https://cdn.example/video.mp4"), true);
assert.equal(isSecureMediaUrl("http://cdn.example/video.mp4"), false);
assert.equal(isSecureMediaUrl("not a URL"), false);
assert.equal(detectMedia({
  responseHeaders: header("application/vnd.apple.mpegurl"),
  url: "https://cdn.example/play?id=1"
}).format, "HLS");
assert.equal(detectMedia({
  responseHeaders: header("application/dash+xml"),
  url: "https://cdn.example/manifest"
}).format, "DASH");
assert.equal(detectMedia({
  responseHeaders: header("video/mp4"),
  type: "media",
  url: "https://cdn.example/signed?id=1"
}).kind, "file");
assert.equal(detectMedia({
  responseHeaders: header("video/mp4"),
  type: "xmlhttprequest",
  url: "https://cdn.example/segment?id=1"
}), null);
assert.equal(detectMedia({
  responseHeaders: header("video/mp2t"),
  url: "https://cdn.example/segment-1.ts"
}), null);
assert.equal(detectMedia({
  responseHeaders: header("image/png"),
  url: "https://cdn.example/poster.png"
}), null);
assert.equal(
  downloadFilename("My Video / StreamTape", { format: "MP4", name: "x8fj2.mp4" }),
  "My Video StreamTape.mp4"
);
assert.equal(
  downloadFilename("CON", { format: "WEBM", name: "random.webm" }),
  "Video CON.webm"
);
assert.equal(
  downloadFilename("", { format: "MP4", name: "fallback.mp4" }),
  "fallback.mp4"
);

assert.equal(detectMedia({
  responseHeaders: [{ name: "content-type", value: "video/mp4" }],
  type: "media",
  url: "https://rr1.googlevideo.com/videoplayback"
}), null);

console.log("media detection check passed");
