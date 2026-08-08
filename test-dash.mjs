import assert from "node:assert/strict";
import {
  adaptationKind,
  carriesBothStreams,
  expandTemplate,
  parseIsoDuration,
  representationSegments,
  selectDashMedia
} from "./dash.mjs";

assert.equal(expandTemplate("seg-$Number$.m4s", { Number: 7 }), "seg-7.m4s");
assert.equal(expandTemplate("seg-$Number%05d$.m4s", { Number: 7 }), "seg-00007.m4s");
assert.equal(expandTemplate("$RepresentationID$/$Time$.m4s", { RepresentationID: "v0", Time: 3600 }), "v0/3600.m4s");
assert.equal(expandTemplate("$Bandwidth$.mp4", { Bandwidth: 800000 }), "800000.mp4");
// A literal dollar survives, and an identifier nobody supplied is left alone
// rather than being blanked out into a wrong URL.
assert.equal(expandTemplate("a$$b", {}), "a$b");
assert.equal(expandTemplate("x-$Unknown$.m4s", { Number: 1 }), "x-$Unknown$.m4s");

assert.equal(parseIsoDuration("PT1H2M3.5S"), 3723.5);
assert.equal(parseIsoDuration("PT30S"), 30);
assert.equal(parseIsoDuration("PT4M"), 240);
assert.equal(parseIsoDuration(""), 0);
assert.equal(parseIsoDuration("nonsense"), 0);

assert.equal(adaptationKind({ contentType: "video", representations: [] }), "video");
assert.equal(adaptationKind({ mimeType: "audio/mp4", representations: [] }), "audio");
// No contentType and no mimeType: the codec string is the only hint left.
assert.equal(adaptationKind({ representations: [{ codecs: "avc1.64001f" }] }), "video");
assert.equal(adaptationKind({ representations: [{ codecs: "mp4a.40.2" }] }), "audio");
assert.equal(carriesBothStreams({ representations: [{ codecs: "avc1.64001f,mp4a.40.2" }] }), true);
assert.equal(carriesBothStreams({ representations: [{ codecs: "avc1.64001f" }] }), false);

// SegmentTemplate with @duration: the count comes from the total runtime, and a
// partial trailing segment still has to be fetched.
assert.deepEqual(representationSegments(
  { bandwidth: 800000, id: "v0" },
  { segmentTemplate: { duration: "4", initialization: "https://cdn.example/v0/init.mp4", media: "https://cdn.example/v0/$Number$.m4s", startNumber: "1", timescale: "1" } },
  10
), {
  initUrl: "https://cdn.example/v0/init.mp4",
  segmentUrls: [
    "https://cdn.example/v0/1.m4s",
    "https://cdn.example/v0/2.m4s",
    "https://cdn.example/v0/3.m4s"
  ]
});

// SegmentTimeline with @r: one entry stands for several segments, and $Time$
// advances by each entry's duration rather than by segment index.
assert.deepEqual(representationSegments(
  { id: "v0" },
  {
    segmentTemplate: {
      media: "https://cdn.example/v0/$Time$.m4s",
      timescale: "1000",
      timeline: [{ d: "4000", r: "2", t: "0" }, { d: "2000" }]
    }
  },
  0
).segmentUrls, [
  "https://cdn.example/v0/0.m4s",
  "https://cdn.example/v0/4000.m4s",
  "https://cdn.example/v0/8000.m4s",
  "https://cdn.example/v0/12000.m4s"
]);

// SegmentList and a bare BaseURL are the older shapes and still turn up.
assert.deepEqual(representationSegments(
  { initUrl: "https://cdn.example/init.mp4", segmentList: ["https://cdn.example/a.m4s"] },
  {},
  0
), { initUrl: "https://cdn.example/init.mp4", segmentUrls: ["https://cdn.example/a.m4s"] });
assert.deepEqual(representationSegments({ baseUrl: "https://cdn.example/whole.mp4" }, {}, 0), {
  initUrl: null,
  segmentUrls: ["https://cdn.example/whole.mp4"]
});

const template = (id) => ({
  duration: "4",
  initialization: `https://cdn.example/${id}/init.mp4`,
  media: `https://cdn.example/${id}/$Number$.m4s`,
  timescale: "1"
});

// The highest-bandwidth representation wins.
const muxed = selectDashMedia({
  adaptationSets: [{
    contentType: "video",
    representations: [
      { bandwidth: 400000, codecs: "avc1.64001f,mp4a.40.2", id: "lo", segmentTemplate: template("lo") },
      { bandwidth: 900000, codecs: "avc1.64001f,mp4a.40.2", id: "hi", segmentTemplate: template("hi") }
    ]
  }],
  durationSeconds: 8
});
assert.equal(muxed.initUrl, "https://cdn.example/hi/init.mp4");
assert.equal(muxed.segmentUrls.length, 2);
assert.equal(muxed.extension, "mp4");
assert.equal(muxed.durationSeconds, 8);

// The common shape: audio in its own adaptation set. Both streams come back so
// the download can merge them into one movie.
const separate = selectDashMedia({
  adaptationSets: [
    { contentType: "video", representations: [{ bandwidth: 900000, codecs: "avc1.64001f", id: "v", segmentTemplate: template("v") }] },
    { contentType: "audio", representations: [{ bandwidth: 128000, codecs: "mp4a.40.2", id: "a", segmentTemplate: template("a") }] }
  ],
  durationSeconds: 8
});
assert.equal(separate.initUrl, "https://cdn.example/v/init.mp4");
assert.equal(separate.audio.initUrl, "https://cdn.example/a/init.mp4");
assert.equal(separate.audio.segmentUrls.length, 2);
// Both streams count toward the estimate, since both get downloaded.
assert.equal(separate.bitsPerSecond, 900000 + 128000);
assert.equal(muxed.bitsPerSecond, 900000);


// A representation that already carries both needs no second stream.
assert.equal(muxed.audio, undefined);

// A video-only manifest with no audio anywhere is still worth saving, and must
// not claim an audio stream that does not exist.
const videoOnly = selectDashMedia({
  adaptationSets: [{ contentType: "video", representations: [{ bandwidth: 900000, codecs: "avc1.64001f", id: "v", segmentTemplate: template("v") }] }],
  durationSeconds: 8
});
assert.equal(videoOnly.segmentUrls.length, 2);
assert.equal(videoOnly.audio, undefined);

assert.throws(() => selectDashMedia({ adaptationSets: [], durationSeconds: 8 }), /error_dash_no_streams/);
assert.throws(() => selectDashMedia({
  adaptationSets: [{ contentType: "video", representations: [{ bandwidth: 1, codecs: "avc1.64001f", id: "v" }] }],
  durationSeconds: 8
}), /error_dash_unsupported/);

console.log("DASH manifest check passed");
