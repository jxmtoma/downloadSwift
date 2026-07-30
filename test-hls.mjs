import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHlsMedia, selectHlsVariant } from "./hls.mjs";

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

assert.throws(
  () => parseHlsMedia("#EXTM3U\n#EXTINF:6,\n1.ts", "https://cdn.example/live.m3u8"),
  /Live HLS/
);
assert.throws(
  () => parseHlsMedia("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXT-X-ENDLIST\n1.ts", "https://cdn.example/vod.m3u8"),
  /Encrypted/
);

console.log("HLS parser check passed");
