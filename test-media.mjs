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
// Embedded players fetch their file over XHR from URLs with no extension.
assert.equal(detectMedia({
  responseHeaders: header("video/mp4"),
  type: "xmlhttprequest",
  url: "https://cdn.example/play/8fj2?token=1"
}).kind, "file");
assert.equal(detectMedia({
  responseHeaders: header("video/mp2t"),
  url: "https://cdn.example/segment-1.ts"
}), null);
// A segment-only mime is the one hint an extensionless URL still gives us.
assert.equal(detectMedia({
  responseHeaders: header("video/mp2t"),
  type: "xmlhttprequest",
  url: "https://cdn.example/seg/1174"
}), null);
assert.equal(detectMedia({
  responseHeaders: header("video/iso.segment"),
  type: "xmlhttprequest",
  url: "https://cdn.example/seg/1174"
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

// Ad beacons and player stubs ship as video/mp4 at a few KB. A real video that
// happens to be fetched by range must survive: its total is on content-range.
const sized = (value, name = "content-length") => [
  { name: "content-type", value: "video/mp4" },
  { name, value }
];
assert.equal(detectMedia({ responseHeaders: sized("3584"), url: "https://ads.example/a.mp4" }), null);
assert.equal(detectMedia({
  responseHeaders: sized("bytes 0-1023/94371840", "content-range"),
  url: "https://cdn.example/video.mp4"
}).size, 94371840, "a ranged response reports the whole file, not the slice");
assert.equal(detectMedia({
  responseHeaders: sized("52428800"),
  url: "https://cdn.example/video.mp4"
}).size, 52428800);
// An unsized response still gets the benefit of the doubt.
assert.equal(detectMedia({
  responseHeaders: [{ name: "content-type", value: "video/mp4" }],
  url: "https://cdn.example/play/8fj2"
}).kind, "file");
// A playlist is small by nature and must not be caught by the file floor. Its
// content-length is the manifest's own size, which says nothing about the video,
// so it must not be reported as one: a two-hour stream looked like 29 KB.
const playlist = detectMedia({
  responseHeaders: [
    { name: "content-type", value: "application/vnd.apple.mpegurl" },
    { name: "content-length", value: "29798" }
  ],
  url: "https://cdn.example/master.m3u8"
});
assert.equal(playlist.format, "HLS");
assert.equal(playlist.size, null, "a manifest's own length is not the video's size");

console.log("media detection check passed");
