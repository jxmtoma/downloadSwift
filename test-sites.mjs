import assert from "node:assert/strict";
import { detectSite, resolveSite } from "./sites.mjs";
import { createBoxSplitter } from "./mp4.mjs";

// Only a video page is an item. The home page, a user page, or a lookalike host
// must not start listing something the extension cannot resolve.
assert.equal(detectSite("https://www.bilibili.com/video/BV12rM96pE6t")?.id, "bilibili");
assert.equal(detectSite("https://www.bilibili.com/video/BV12rM96pE6t/?p=2")?.id, "bilibili");
assert.equal(detectSite("https://bilibili.com/video/av170001")?.id, "bilibili");
assert.equal(detectSite("https://www.bilibili.com/"), null);
assert.equal(detectSite("https://space.bilibili.com/123"), null);
assert.equal(detectSite("https://notbilibili.com/video/BV1"), null);
assert.equal(detectSite("https://evil.example/www.bilibili.com/video/BV1"), null);
assert.equal(detectSite(undefined), null);

const detected = detectSite("https://www.bilibili.com/video/BV12rM96pE6t");
assert.equal(detected.item.kind, "playlist");
assert.equal(detected.item.format, "DASH");
assert.equal(detected.item.adapter, "bilibili");
// The media hosts answer 403 without it, and the page is never fetched, so the
// referer is stated rather than captured from a request.
assert.deepEqual(detected.item.requestHeaders, [
  { name: "referer", value: "https://www.bilibili.com/" }
]);

const answers = {
  pagelist: { code: 0, data: [{ cid: 40568097003, part: "A title" }] },
  playurl: {
    code: 0,
    data: {
      dash: {
        audio: [
          { SegmentBase: { Initialization: "0-836", indexRange: "837-1344" }, bandwidth: 65748, baseUrl: "https://cdn.example/a-low.m4s" },
          { SegmentBase: { Initialization: "0-900", indexRange: "901-1400" }, bandwidth: 132000, baseUrl: "https://cdn.example/a-high.m4s" }
        ],
        duration: 192,
        video: [
          { SegmentBase: { Initialization: "0-934", indexRange: "935-1454" }, bandwidth: 357954, baseUrl: "https://cdn.example/v-low.m4s" },
          { SegmentBase: { Initialization: "0-999", indexRange: "1000-1500" }, bandwidth: 1200000, baseUrl: "https://cdn.example/v-high.m4s" }
        ]
      },
      timelength: 191744
    }
  }
};

const requested = [];
const fetchJson = async (url) => {
  requested.push(url);
  return url.includes("pagelist") ? answers.pagelist : answers.playurl;
};

const media = await resolveSite(detected.item, fetchJson);

// The cid has to be looked up first; playurl cannot be asked without it.
assert.match(requested[0], /pagelist\?bvid=BV12rM96pE6t$/);
assert.match(requested[1], /playurl\?bvid=BV12rM96pE6t&cid=40568097003&fnval=4048&fourk=1$/);

assert.equal(media.title, "A title");
assert.equal(media.durationSeconds, 192);
assert.equal(media.extension, "mp4");
// Highest bandwidth wins for both tracks.
assert.equal(media.video.url, "https://cdn.example/v-high.m4s");
assert.equal(media.audio.url, "https://cdn.example/a-high.m4s");
// The header is the Initialization range; the media is everything past the index.
assert.equal(media.video.initRange, "bytes=0-999");
assert.equal(media.video.mediaRange, "bytes=1501-");
assert.equal(media.audio.initRange, "bytes=0-900");
assert.equal(media.audio.mediaRange, "bytes=1401-");

// An av-numbered page uses the other identifier.
await resolveSite(detectSite("https://www.bilibili.com/video/av170001").item, fetchJson);
assert.match(requested[2], /pagelist\?aid=170001$/);

// A response with no DASH payload is a refusal, not something to half-download.
await assert.rejects(
  () => resolveSite(detected.item, async () => ({ code: -404, data: null })),
  /error_site_unresolved/
);
await assert.rejects(
  () => resolveSite(detected.item, async (url) => (
    url.includes("pagelist") ? answers.pagelist : { code: 0, data: { durl: [{ url: "x" }] } }
  )),
  /error_site_unresolved/
);
await assert.rejects(() => resolveSite({ adapter: "nope" }, fetchJson), /error_site_unresolved/);

// The splitter has to survive arbitrary chunk boundaries: a self-contained track
// arrives as network chunks that cut through box headers, not on box edges.
const makeBox = (type, payload) => {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set([...type].map((character) => character.charCodeAt(0)), 4);
  bytes.set(payload, 8);
  return bytes;
};
const stream = new Uint8Array([
  ...makeBox("moof", new Uint8Array(20).fill(1)),
  ...makeBox("mdat", new Uint8Array(100).fill(2)),
  ...makeBox("moof", new Uint8Array(20).fill(3)),
  ...makeBox("mdat", new Uint8Array(50).fill(4))
]);

for (const size of [1, 3, 7, 8, 9, 64, 1000]) {
  const split = createBoxSplitter();
  const seen = [];
  for (let at = 0; at < stream.length; at += size) {
    seen.push(...split(stream.subarray(at, Math.min(at + size, stream.length))));
  }
  assert.deepEqual(
    seen.map((box) => box.type),
    ["moof", "mdat", "moof", "mdat"],
    `chunk size ${size} must not lose or split a box`
  );
  assert.deepEqual(
    seen.map((box) => box.bytes.length),
    [28, 108, 28, 58],
    `chunk size ${size} must reassemble every box whole`
  );
}

// A trailing partial box is held back rather than emitted half-formed.
const partial = createBoxSplitter();
assert.deepEqual(partial(stream.subarray(0, 20)), []);
assert.deepEqual(partial(stream.subarray(20, 28)).map((box) => box.type), ["moof"]);

console.log("site adapter check passed");
