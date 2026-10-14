import assert from "node:assert/strict";
import fs from "node:fs";
import { getMedia } from "./resolve.mjs";
import { combineVttSegments, createHlsDecryptor, parseHlsMedia, parseHlsVariants, selectHlsVariant } from "./hls.mjs";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;

const english = JSON.parse(fs.readFileSync("_locales/en/messages.json", "utf8"));
globalThis.chrome = {
  i18n: { getMessage: (key) => english[key]?.message || "" }
};

const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000
high/index.m3u8`;
assert.equal(
  selectHlsVariant(master, "https://cdn.example/master.m3u8").url,
  "https://cdn.example/high/index.m3u8"
);

const splitMaster = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="English",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="stereo"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="stereo"
high/index.m3u8`;
assert.equal(parseHlsVariants(splitMaster, "https://cdn.example/master.m3u8")[1].resolution, "1280x720");
assert.equal(
  selectHlsVariant(
    splitMaster.replace("low/index.m3u8", "low/fresh.m3u8"),
    "https://cdn.example/master.m3u8",
    "https://cdn.example/low/expired.m3u8",
    0
  ).url,
  "https://cdn.example/low/fresh.m3u8"
);
assert.deepEqual(
  selectHlsVariant(splitMaster, "https://cdn.example/master.m3u8"),
  {
    audioUrl: "https://cdn.example/audio/index.m3u8",
    bandwidth: 2400000,
    url: "https://cdn.example/high/index.m3u8"
  }
);

// A master offering the same video in two codecs. AV1 is the bigger, sharper
// variant and the one a bandwidth sort picks, and the file it produces refuses
// to open in QuickTime on any Mac older than an M3 — macOS has no AV1 decoder
// to fall back on. Whether the download opens at all outranks how sharp it is.
const codecMaster = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.640028,mp4a.40.2"
h264/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x1080,CODECS="av01.0.08M.08,mp4a.40.2"
av1/index.m3u8`;
assert.equal(
  parseHlsVariants(codecMaster, "https://cdn.example/master.m3u8")[1].codecs,
  "av01.0.08M.08,mp4a.40.2",
  "CODECS is quoted and holds a comma, so it has to survive the attribute split"
);
assert.equal(
  selectHlsVariant(codecMaster, "https://cdn.example/master.m3u8").url,
  "https://cdn.example/h264/index.m3u8"
);
// Ranking is only the default. An explicit pick is still honoured: the picker
// lists every variant, and choosing the sharper file is the user's to make.
assert.equal(
  selectHlsVariant(
    codecMaster,
    "https://cdn.example/master.m3u8",
    "https://cdn.example/av1/index.m3u8"
  ).url,
  "https://cdn.example/av1/index.m3u8"
);
// A master that states no codecs at all must still sort by bandwidth: unknown
// is not the same as unplayable, and demoting it would pick the worst variant.
assert.equal(
  selectHlsVariant(master, "https://cdn.example/master.m3u8").url,
  "https://cdn.example/high/index.m3u8"
);

const media = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
segment-1.m4s
#EXTINF:6,
segment-2.m4s
#EXT-X-ENDLIST`;
assert.deepEqual(parseHlsMedia(media, "https://cdn.example/high/index.m3u8"), {
  durationSeconds: 12,
  extension: "mp4",
  initUrl: "https://cdn.example/high/init.mp4",
  segmentDurations: [6, 6],
  segmentUrls: [
    "https://cdn.example/high/segment-1.m4s",
    "https://cdn.example/high/segment-2.m4s"
  ]
});

const audio = `#EXTM3U
#EXT-X-MAP:URI="init-audio.mp4"
#EXTINF:6,
audio-1.m4s
#EXTINF:6,
audio-2.m4s
#EXT-X-ENDLIST`;
const video = media.replaceAll("init.mp4", "init-video.mp4").replaceAll("segment-", "video-");
const playlists = new Map([
  ["https://cdn.example/master.m3u8", splitMaster],
  ["https://cdn.example/low/index.m3u8", video],
  ["https://cdn.example/high/index.m3u8", video],
  ["https://cdn.example/audio/index.m3u8", audio]
]);
const split = await getMedia(
  { format: "HLS", kind: "playlist", url: "https://cdn.example/master.m3u8" },
  { fetchText: async (url) => playlists.get(url) }
);
assert.equal(split.audio.initUrl, "https://cdn.example/audio/init-audio.mp4");
assert.deepEqual(split.audio.segmentUrls, [
  "https://cdn.example/audio/audio-1.m4s",
  "https://cdn.example/audio/audio-2.m4s"
]);

const selectedLow = await getMedia(
  {
    format: "HLS",
    kind: "playlist",
    url: "https://cdn.example/master.m3u8",
    variantUrl: "https://cdn.example/low/index.m3u8"
  },
  { fetchText: async (url) => playlists.get(url) }
);
assert.deepEqual(selectedLow.segmentUrls, [
  "https://cdn.example/low/video-1.m4s",
  "https://cdn.example/low/video-2.m4s"
]);

playlists.set(
  "https://cdn.example/audio/index.m3u8",
  audio.replace("#EXT-X-MAP:URI=\"init-audio.mp4\"\n", "").replaceAll(".m4s", ".ts")
);
await assert.rejects(
  () => getMedia(
    { format: "HLS", kind: "playlist", url: "https://cdn.example/master.m3u8" },
    { fetchText: async (url) => playlists.get(url) }
  ),
  /audio and video separate/
);

assert.throws(
  () => parseHlsMedia("#EXTM3U\n#EXTINF:6,\n1.ts", "https://cdn.example/live.m3u8"),
  /Live HLS/
);

const encryptedPlaylist = (tags) => `#EXTM3U\n${tags}\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST`;
const implicitIv = parseHlsMedia(encryptedPlaylist(
  '#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-KEY:METHOD=AES-128,URI="keys/one.key"'
), "https://cdn.example/video/list.m3u8");
assert.deepEqual(implicitIv.segmentKeys, [{ keyUrl: "https://cdn.example/video/keys/one.key", sequence: "1" }]);
const largeSequence = parseHlsMedia(encryptedPlaylist(
  '#EXT-X-MEDIA-SEQUENCE:9007199254740993\n#EXT-X-KEY:METHOD=AES-128,URI="key"'
), "https://cdn.example/list.m3u8").segmentKeys[0];
assert.equal(largeSequence.sequence, "9007199254740993");
const explicitIv = parseHlsMedia(encryptedPlaylist(
  '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0X0A'
), "https://cdn.example/list.m3u8");
assert.deepEqual(explicitIv.segmentKeys[0], {
  iv: "0x0000000000000000000000000000000a",
  keyUrl: "https://cdn.example/key",
  sequence: "0"
});
const rotated = parseHlsMedia(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="one"
#EXTINF:6,
one.ts
#EXT-X-KEY:METHOD=AES-128,URI="two",IV=0x00000000000000000000000000000002
#EXTINF:6,
two.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:6,
clear.ts
#EXT-X-ENDLIST`, "https://cdn.example/list.m3u8");
assert.equal(rotated.segmentKeys[0].keyUrl, "https://cdn.example/one");
assert.equal(rotated.segmentKeys[1].keyUrl, "https://cdn.example/two");
assert.equal(rotated.segmentKeys[2], null);
assert.throws(() => parseHlsMedia(encryptedPlaylist(
  '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x123456789012345678901234567890123'
), "https://cdn.example/list.m3u8"), /encryption/i);
assert.throws(() => parseHlsMedia(encryptedPlaylist(
  '#EXT-X-KEY:METHOD=AES-128,URI="http://cdn.example/key"'
), "https://cdn.example/list.m3u8"), /encryption/i);
assert.throws(() => parseHlsMedia(encryptedPlaylist(
  '#EXT-X-KEY:METHOD=AES-128,URI="http://[::1"'
), "https://cdn.example/list.m3u8"), /encryption/i);
assert.throws(() => parseHlsMedia(encryptedPlaylist(
  '#EXT-X-KEY:METHOD=AES-128,URI="key",KEYFORMAT="com.example.drm"'
), "https://cdn.example/list.m3u8"), /encryption/i);
assert.throws(() => parseHlsMedia(encryptedPlaylist(
  '#EXT-X-KEY:METHOD=AES-128,URI="key",KEYFORMATVERSIONS="2"'
), "https://cdn.example/list.m3u8"), /encryption/i);
assert.equal(parseHlsMedia(encryptedPlaylist(
  '#EXT-X-KEY:METHOD=AES-128,URI="key",KEYFORMATVERSIONS="1/2"'
), "https://cdn.example/list.m3u8").segmentKeys[0].keyUrl, "https://cdn.example/key");
assert.throws(() => parseHlsMedia(encryptedPlaylist(
  '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"'
), "https://cdn.example/list.m3u8"), /encryption/i);
assert.throws(() => parseHlsMedia(encryptedPlaylist(
  '#EXT-X-MEDIA-SEQUENCE:1x\n#EXT-X-KEY:METHOD=AES-128,URI="key"'
), "https://cdn.example/list.m3u8"), /encryption/i);
assert.throws(() => parseHlsMedia(encryptedPlaylist(
  '#EXT-X-MEDIA-SEQUENCE:18446744073709551616\n#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1'
), "https://cdn.example/list.m3u8"), /encryption/i);
assert.throws(() => parseHlsMedia(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:6,
one.ts
#EXT-X-MEDIA-SEQUENCE:2
#EXTINF:6,
two.ts
#EXT-X-ENDLIST`, "https://cdn.example/list.m3u8"), /encryption/i);
assert.throws(() => parseHlsMedia(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key"
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
seg.m4s
#EXT-X-ENDLIST`, "https://cdn.example/list.m3u8"), /encryption/i);
assert.deepEqual(parseHlsMedia(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x00000000000000000000000000000001
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="rotated",IV=0x00000000000000000000000000000002
#EXTINF:6,
seg.m4s
#EXT-X-ENDLIST`, "https://cdn.example/list.m3u8").initKey, {
  iv: "0x00000000000000000000000000000001", keyUrl: "https://cdn.example/key"
});

const rawKey = new Uint8Array(16).map((_, index) => index + 1);
const iv = new Uint8Array(16).fill(0);
iv[15] = 10;
const plaintext = new Uint8Array(fs.readFileSync("test-fixtures/h264-aac.ts"));
const nodeCipher = (await import("node:crypto")).createCipheriv("aes-128-cbc", rawKey, iv);
const ciphertext = new Uint8Array(Buffer.concat([nodeCipher.update(plaintext), nodeCipher.final()]));
let keyFetches = 0;
const decrypt = createHlsDecryptor(async () => { keyFetches += 1; return rawKey; });
const decrypted = await decrypt(ciphertext, explicitIv.segmentKeys[0]);
assert.deepEqual(decrypted, plaintext);
await decrypt(ciphertext, explicitIv.segmentKeys[0]);
assert.equal(keyFetches, 1, "AES keys are imported and fetched once per decryptor");
const largeIv = new Uint8Array(16);
new DataView(largeIv.buffer).setBigUint64(8, BigInt(largeSequence.sequence));
const largeCipher = (await import("node:crypto")).createCipheriv("aes-128-cbc", rawKey, largeIv);
const largeCiphertext = new Uint8Array(Buffer.concat([largeCipher.update(plaintext), largeCipher.final()]));
assert.deepEqual(await decrypt(largeCiphertext, largeSequence), plaintext);
const fetchFailure = new Error("key request failed");
await assert.rejects(
  createHlsDecryptor(async () => { throw fetchFailure; })(ciphertext, explicitIv.segmentKeys[0]),
  (error) => error === fetchFailure
);
await assert.rejects(
  createHlsDecryptor(async () => new Uint8Array(15))(ciphertext, explicitIv.segmentKeys[0]),
  /encryption/i
);
await assert.rejects(
  createHlsDecryptor(async () => rawKey)(Uint8Array.of(1), explicitIv.segmentKeys[0]),
  /encryption/i
);
assert.equal(parseHlsMedia(
  "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXT-X-ENDLIST\n1.ts",
  "https://cdn.example/vod.m3u8"
).segmentKeys[0].keyUrl, "https://cdn.example/key");

// A master with a subtitle rendition: the variant selection hands back the
// subtitle playlist next to the audio one.
const subtitledMaster = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="English",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="subs/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Deutsch",URI="subs/de.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="stereo",SUBTITLES="subs"
high/index.m3u8`;
const withSubtitles = selectHlsVariant(subtitledMaster, "https://cdn.example/master.m3u8");
assert.equal(withSubtitles.subtitleUrl, "https://cdn.example/subs/en.m3u8");
assert.deepEqual(
  parseHlsVariants(subtitledMaster, "https://cdn.example/master.m3u8")[0].subtitleGroup,
  "subs"
);

// Subtitle playlists come through getMedia as a second stream of segments.
const subtitlePlaylist = `#EXTM3U
#EXT-X-MAP:URI="init.vtt"
#EXTINF:6,
sub-1.vtt
#EXTINF:6,
sub-2.vtt
#EXT-X-ENDLIST`;
const subtitleTextPlaylists = new Map([
  ["https://cdn.example/master.m3u8", subtitledMaster],
  ["https://cdn.example/high/index.m3u8", video],
  ["https://cdn.example/audio/index.m3u8", audio],
  ["https://cdn.example/subs/en.m3u8", subtitlePlaylist]
]);
const subtitleMedia = await getMedia(
  { format: "HLS", kind: "playlist", url: "https://cdn.example/master.m3u8" },
  { fetchText: async (url) => subtitleTextPlaylists.get(url) }
);
assert.equal(subtitleMedia.subtitle.initUrl, "https://cdn.example/subs/init.vtt");
assert.deepEqual(subtitleMedia.subtitle.segmentUrls, [
  "https://cdn.example/subs/sub-1.vtt",
  "https://cdn.example/subs/sub-2.vtt"
]);
assert.deepEqual(subtitleMedia.subtitle.segmentDurations, [6, 6]);

// A broken subtitle rendition costs the subtitles, never the video.
subtitleTextPlaylists.set("https://cdn.example/subs/en.m3u8", "#EXTM3U\n#EXT-X-ENDLIST");
const subtitleless = await getMedia(
  { format: "HLS", kind: "playlist", url: "https://cdn.example/master.m3u8" },
  { fetchText: async (url) => subtitleTextPlaylists.get(url) }
);
assert.equal(subtitleless.subtitle, undefined);
assert.equal(subtitleless.segmentUrls.length, 2);

// Audio-only resolves straight to the audio rendition, no video playlist.
const audioOnly = await getMedia(
  {
    audioOnly: true,
    format: "HLS",
    kind: "playlist",
    url: "https://cdn.example/master.m3u8"
  },
  { fetchText: async (url) => subtitleTextPlaylists.get(url) }
);
assert.equal(audioOnly.audioOnly, true);
assert.equal(audioOnly.initUrl, "https://cdn.example/audio/init-audio.mp4");
assert.deepEqual(audioOnly.segmentUrls, [
  "https://cdn.example/audio/audio-1.m4s",
  "https://cdn.example/audio/audio-2.m4s"
]);

// A muxed master with no separate audio group cannot be split.
await assert.rejects(
  () => getMedia(
    {
      audioOnly: true,
      format: "HLS",
      kind: "playlist",
      url: "https://cdn.example/master.m3u8"
    },
    { fetchText: async (url) => (url === "https://cdn.example/master.m3u8" ? master : undefined) }
  ),
  /audio-only track/
);

// Subtitle segments are whole WebVTT files with segment-local timestamps. The
// joined sidecar re-times every cue onto one timeline, normalises the MPEGTS
// base away so subtitle zero is video zero, and writes a cue a player carries
// across a segment boundary only once.
assert.equal(
  combineVttSegments([
    "WEBVTT\nX-TIMESTAMP-MAP:LOCAL:00:00:00.000,MPEGTS:900000\n\n00:00:00.500 --> 00:00:02.000\nHello\n\n00:00:02.000 --> 00:00:04.000\nCarried over",
    "WEBVTT\nX-TIMESTAMP-MAP:LOCAL:00:00:00.000,MPEGTS:900000\n\n00:00:02.000 --> 00:00:04.000\nCarried over\n\n00:00:04.500 --> 00:00:06.000\nWorld"
  ]),
  [
    "WEBVTT",
    "",
    "00:00:00.500 --> 00:00:02.000",
    "Hello",
    "",
    "00:00:02.000 --> 00:00:04.000",
    "Carried over",
    "",
    "00:00:04.500 --> 00:00:06.000",
    "World",
    ""
  ].join("\n")
);

// Each segment's map states where its local zero sits on the timeline, so the
// second segment's cues land four seconds after the first's even though both
// are numbered from zero.
assert.equal(
  combineVttSegments([
    "WEBVTT\nX-TIMESTAMP-MAP:LOCAL:00:00:00.000,MPEGTS:900000\n\n00:00:00.000 --> 00:00:02.000\nOne",
    "WEBVTT\nX-TIMESTAMP-MAP:LOCAL:00:00:00.000,MPEGTS:1260000\n\n00:00:00.000 --> 00:00:01.500\nTwo"
  ]),
  [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:02.000",
    "One",
    "",
    "00:00:04.000 --> 00:00:05.500",
    "Two",
    ""
  ].join("\n")
);

// Without a timestamp map the segments are offset by the durations that came
// with the playlist.
assert.equal(
  combineVttSegments([
    "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nOne",
    "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nTwo"
  ], [4, 4]),
  [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:02.000",
    "One",
    "",
    "00:00:04.000 --> 00:00:05.500",
    "Two",
    ""
  ].join("\n")
);

// Cue settings survive the join.
assert.match(
  combineVttSegments(["WEBVTT\n\n00:00:00.000 --> 00:00:02.000 align:start position:10%\nHi"]),
  /^00:00:00\.000 --> 00:00:02\.000 align:start position:10%$/m
);

// Byte-range playlists: segments are slices of one resource, addressed with
// explicit offsets or chained implicitly from the previous segment's end, and
// the initialization segment can be a range of its own.
const ranged = `#EXTM3U
#EXT-X-MAP:URI="init.mp4",BYTERANGE="600@0"
#EXTINF:4,
#EXT-X-BYTERANGE:100@600
seg-0.m4s
#EXTINF:4,
#EXT-X-BYTERANGE:100
seg-1.m4s
#EXTINF:4,
whole.m4s
#EXT-X-ENDLIST`;
const rangeMedia = parseHlsMedia(ranged, "https://cdn.example/ranged/index.m3u8");
assert.deepEqual(rangeMedia.initRange, { end: 599, start: 0 });
assert.deepEqual(rangeMedia.segmentRanges, [
  { end: 699, start: 600 },
  { end: 799, start: 700 },
  null
]);
assert.equal(rangeMedia.extension, "mp4");

// A playlist without byte ranges carries no range data at all.
assert.equal(parseHlsMedia(media, "https://cdn.example/high/index.m3u8").segmentRanges, undefined);

// Segments of one resource must sit inside a single continuous encoding:
// discontinuities and rotating initialization segments stay rejected.
assert.throws(
  () => parseHlsMedia(
    "#EXTM3U\n#EXT-X-BYTERANGE:10@0\nseg.ts\n#EXT-X-DISCONTINUITY\n#EXT-X-BYTERANGE:10@10\nseg.ts\n#EXT-X-ENDLIST",
    "https://cdn.example/broken.m3u8"
  ),
  /Byte ranges spanning/
);
assert.throws(
  () => parseHlsMedia(
    "#EXTM3U\n#EXT-X-MAP:URI=\"a.mp4\"\n#EXT-X-BYTERANGE:10@0\nseg.m4s\n#EXT-X-MAP:URI=\"b.mp4\"\n#EXT-X-BYTERANGE:10@10\nseg2.m4s\n#EXT-X-ENDLIST",
    "https://cdn.example/rotating.m3u8"
  ),
  /Byte ranges spanning/
);

// getMedia passes byte ranges through untouched.
const rangeResolved = await getMedia(
  { format: "HLS", kind: "playlist", url: "https://cdn.example/ranged/index.m3u8" },
  { fetchText: async (url) => (url === "https://cdn.example/ranged/index.m3u8" ? ranged : undefined) }
);
assert.deepEqual(rangeResolved.initRange, { end: 599, start: 0 });
assert.deepEqual(rangeResolved.segmentRanges[0], { end: 699, start: 600 });

console.log("HLS parser check passed");
