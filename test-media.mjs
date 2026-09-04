import assert from "node:assert/strict";
import {
  byPlayability,
  candidateRank,
  detectMedia,
  downloadFilename,
  isSecureMediaUrl
} from "./media.mjs";

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
  responseHeaders: header("text/plain"),
  url: "https://cdn.example/hls/video-id/master.txt"
}).format, "HLS");
assert.equal(detectMedia({
  responseHeaders: header("text/plain"),
  url: "https://cdn.example/config/master.txt"
}), null, "ordinary text files must not become media");
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

// The list is built newest-first, and a page's hover-preview clips load after
// the video they preview, so the previews sat above it. They are ranked down
// rather than filtered out: each one is a real MP4 someone could have meant.
const rank = (items) => items.sort((left, right) => candidateRank(right) - candidateRank(left))
  .map((item) => item.name);
assert.deepEqual(
  rank([
    { kind: "file", name: "preview-2.mp4", size: 300 * 1024 },
    { kind: "file", name: "preview-1.mp4", size: 200 * 1024 },
    { kind: "playlist", name: "master.m3u8", size: null },
    { kind: "file", name: "video.mp4", size: 400 * 1024 * 1024 }
  ]),
  ["master.m3u8", "video.mp4", "preview-2.mp4", "preview-1.mp4"]
);
// An unsized file keeps the benefit of the doubt the floor already gives it,
// rather than sinking below every preview that happened to state a length.
assert.deepEqual(
  rank([
    { kind: "file", name: "preview.mp4", size: 300 * 1024 },
    { kind: "file", name: "8fj2", size: null }
  ]),
  ["8fj2", "preview.mp4"]
);

// Codec beats bitrate when the two disagree, because a sharper file that no
// decoder on the machine can open is worth less than a playable one. HEVC sits
// between the two: Macs have decoded it in hardware since 2017.
const best = (variants) => [...variants].sort(byPlayability)[0].name;
assert.equal(best([
  { bandwidth: 4000000, codecs: "av01.0.08M.08,mp4a.40.2", name: "av1-1080p" },
  { bandwidth: 800000, codecs: "avc1.640028,mp4a.40.2", name: "h264-360p" }
]), "h264-360p");
assert.equal(best([
  { bandwidth: 4000000, codecs: "av01.0.08M.08", name: "av1" },
  { bandwidth: 2000000, codecs: "hvc1.1.6.L93.B0", name: "hevc" }
]), "hevc");
// Within one codec the sharper variant still wins.
assert.equal(best([
  { bandwidth: 800000, codecs: "avc1.4d401e", name: "h264-360p" },
  { bandwidth: 4000000, codecs: "avc1.640028", name: "h264-1080p" }
]), "h264-1080p");
// A variant that states no codec keeps the benefit of the doubt: it outranks a
// known-unplayable one and yields to a known-good one, whatever its bitrate.
assert.equal(best([
  { bandwidth: 4000000, codecs: "av01.0.08M.08", name: "av1" },
  { bandwidth: 900000, name: "unstated" }
]), "unstated");
assert.equal(best([
  { bandwidth: 4000000, name: "unstated" },
  { bandwidth: 900000, codecs: "avc1.4d401e", name: "h264" }
]), "h264");
// Audio representations state no video codec at all, so they all tie and fall
// through to bandwidth — the same order they had before any of this existed.
assert.equal(best([
  { bandwidth: 64000, codecs: "mp4a.40.2", name: "aac-low" },
  { bandwidth: 128000, codecs: "mp4a.40.2", name: "aac-high" }
]), "aac-high");

console.log("media detection check passed");
