import assert from "node:assert/strict";
import fs from "node:fs";
import { getMedia } from "./resolve.mjs";
import { parseHlsMedia, parseHlsVariants, selectHlsVariant } from "./hls.mjs";

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
assert.throws(
  () => parseHlsMedia("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXT-X-ENDLIST\n1.ts", "https://cdn.example/vod.m3u8"),
  /Encrypted/
);

console.log("HLS parser check passed");
