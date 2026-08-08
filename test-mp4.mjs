import assert from "node:assert/strict";
import fs from "node:fs";
import {
  boxes,
  combineInitSegments,
  createProgressiveMp4,
  findBox,
  fragmentStartTime,
  readTimescale,
  readTrackId,
  renumberFragment
} from "./mp4.mjs";

const read = (name) => new Uint8Array(fs.readFileSync(`test-fixtures/dash/${name}`));
const videoInit = read("video-init.m4s");
const audioInit = read("audio-init.m4s");
const videoSegment = read("video-1.m4s");
const audioSegment = read("audio-1.m4s");

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const trackIdOf = (bytes, box) => view(bytes).getUint32(box.body + (bytes[box.body] === 1 ? 20 : 12));

function traks(bytes) {
  const moov = findBox(bytes, ["moov"]);
  return [...boxes(bytes, moov.body, moov.end)]
    .filter((box) => box.type === "trak")
    .map((trak) => ({
      handler: String.fromCharCode(
        ...bytes.subarray(
          findBox(bytes, ["mdia", "hdlr"], trak.body, trak.end).body + 8,
          findBox(bytes, ["mdia", "hdlr"], trak.body, trak.end).body + 12
        )
      ),
      timescale: (() => {
        const mdhd = findBox(bytes, ["mdia", "mdhd"], trak.body, trak.end);
        return view(bytes).getUint32(mdhd.body + (bytes[mdhd.body] === 1 ? 20 : 12));
      })(),
      trackId: trackIdOf(bytes, findBox(bytes, ["tkhd"], trak.body, trak.end))
    }));
}

function fragmentTrackIds(bytes) {
  const ids = [];
  for (const top of boxes(bytes)) {
    if (top.type !== "moof") continue;
    for (const traf of boxes(bytes, top.body, top.end)) {
      if (traf.type !== "traf") continue;
      ids.push(view(bytes).getUint32(findBox(bytes, ["tfhd"], traf.body, traf.end).body + 4));
    }
  }
  return ids;
}

// Both streams are authored on their own, so both call themselves track 1. That
// collision is the whole reason the merge has to renumber anything.
assert.equal(readTrackId(videoInit), 1);
assert.equal(readTrackId(audioInit), 1);

const { audioTrackId, initSegment, videoTrackId } = combineInitSegments(videoInit, audioInit, 8.933333);
assert.equal(videoTrackId, 1);
assert.equal(audioTrackId, 2);

const merged = traks(initSegment);
assert.equal(merged.length, 2, "the merged header must declare both tracks");
assert.deepEqual(merged.map((trak) => trak.handler), ["vide", "soun"]);
// The regression that shipped: the moov kept saying track 1 for audio while its
// fragments said 2, so a player read the audio timeline on the video clock.
assert.deepEqual(merged.map((trak) => trak.trackId), [1, 2]);
assert.deepEqual(merged.map((trak) => trak.timescale), [90000, 44100]);

const mvex = findBox(initSegment, ["moov", "mvex"]);
const mvexChildren = [...boxes(initSegment, mvex.body, mvex.end)].map((box) => box.type);
assert.deepEqual(mvexChildren, ["mehd", "trex", "trex"], "a fragmented movie declares its length in mehd");
const trexIds = [...boxes(initSegment, mvex.body, mvex.end)]
  .filter((box) => box.type === "trex")
  .map((box) => view(initSegment).getUint32(box.body + 4));
assert.deepEqual(trexIds, [1, 2], "trex defaults must follow the renumbered tracks");

// mehd is version 1, so the duration is 64-bit in the movie timescale.
const mehd = findBox(initSegment, ["moov", "mvex", "mehd"]);
const mvhd = findBox(initSegment, ["moov", "mvhd"]);
const movieTimescale = view(initSegment).getUint32(mvhd.body + (initSegment[mvhd.body] === 1 ? 20 : 12));
assert.equal(
  Number(view(initSegment).getBigUint64(mehd.body + 4)) / movieTimescale,
  Math.round(8.933333 * movieTimescale) / movieTimescale
);

assert.deepEqual(fragmentTrackIds(videoSegment), [1]);
assert.deepEqual(fragmentTrackIds(audioSegment), [1]);
assert.deepEqual(fragmentTrackIds(renumberFragment(videoSegment, videoTrackId, 1)), [1]);
assert.deepEqual(fragmentTrackIds(renumberFragment(audioSegment, audioTrackId, 2)), [2]);

// Renumbering must not disturb anything else in the fragment.
const renumbered = renumberFragment(audioSegment, 2, 7);
assert.equal(renumbered.length, audioSegment.length);
assert.equal(view(renumbered).getUint32(findBox(renumbered, ["moof", "mfhd"]).body + 4), 7);
assert.deepEqual(
  [...boxes(renumbered)].map((box) => box.type),
  [...boxes(audioSegment)].map((box) => box.type)
);

// The source fragments are left untouched; every rewrite works on a copy.
assert.deepEqual(fragmentTrackIds(audioSegment), [1]);

// Interleaving needs two things per fragment: where it starts on its own track's
// clock, and what that clock counts in. Getting either wrong writes the tracks
// out in the wrong order.
assert.equal(readTimescale(videoInit), 90000);
assert.equal(readTimescale(audioInit), 44100);
assert.equal(readTimescale(new Uint8Array(8)), 1, "an unreadable header must not divide by zero");

const videoMoof = (() => {
  const moof = findBox(videoSegment, ["moof"]);
  return videoSegment.subarray(moof.at, moof.end);
})();
assert.equal(fragmentStartTime(videoMoof), 0, "the opening fragment starts at zero");
assert.equal(fragmentStartTime(new Uint8Array(8)), 0);

// A fragment further in reports a non-zero start, which is what orders it.
const shifted = new Uint8Array(videoMoof);
const tfdt = findBox(shifted, ["moof", "traf", "tfdt"]);
const shiftedView = new DataView(shifted.buffer, shifted.byteOffset, shifted.byteLength);
// tfdt is a full box: version 1 states the time in 64 bits, version 0 in 32.
if (shifted[tfdt.body] === 1) shiftedView.setBigUint64(tfdt.body + 4, 180000n);
else shiftedView.setUint32(tfdt.body + 4, 180000);
assert.equal(fragmentStartTime(shifted), 180000);

// A fragmented file is unreadable on macOS: CoreAudio reports zero packets and
// zero duration for one, so downloads played broken in every browser there. The
// same samples are rewritten into a progressive file with real sample tables.
const progressive = createProgressiveMp4(initSegment);
const sampleBytes = progressive.addFragment(
  (() => { const m = findBox(videoSegment, ["moof"]); return videoSegment.subarray(m.at, m.end); })(),
  (() => { const m = findBox(videoSegment, ["mdat"]); return videoSegment.subarray(m.at, m.end); })()
);
assert.ok(sampleBytes.length > 0, "the fragment's samples must come back to be written");

const header = progressive.header();
assert.equal(String.fromCharCode(...header.subarray(4, 8)), "ftyp",
  "a file that opens with mdat is rejected outright by macOS");
assert.equal(String.fromCharCode(...header.subarray(header.length - 12, header.length - 8)), "mdat");
assert.equal(header.length, progressive.prefixSize);

const finished = progressive.moov();
assert.equal(String.fromCharCode(...finished.subarray(4, 8)), "moov");
// No mvex: there are no fragments left for it to describe.
assert.equal(findBox(finished, ["moov", "mvex"]), null);

const rebuiltTrak = findBox(finished, ["moov", "trak"]);
const stbl = findBox(finished, ["mdia", "minf", "stbl"], rebuiltTrak.body, rebuiltTrak.end);
const tables = [...boxes(finished, stbl.body, stbl.end)].map((b) => b.type);
assert.ok(tables.includes("stsd"), "the codec description is kept as authored");
for (const required of ["stts", "stsz", "stsc", "co64"]) {
  assert.ok(tables.includes(required), `a progressive file needs ${required}`);
}

// Every enclosing box has to be resized when the tables are swapped in. Leaving
// them stale produced a moov that lost one track entirely and truncated the other.
const walk = (bytes, start, end) => {
  for (const child of boxes(bytes, start, end)) {
    assert.ok(child.end <= end, `${child.type} overruns its parent`);
    if (["trak", "mdia", "minf", "stbl"].includes(child.type)) walk(bytes, child.body, child.end);
  }
};
walk(finished, findBox(finished, ["moov"]).body, findBox(finished, ["moov"]).end);

// Composition offsets appear whenever the encoder used B-frames, which neither
// other fixture does, so this path went untested while every real video uses it.
// They are written as ctts version 0: version 1's signed offsets are read far
// less reliably, QuickTime among the readers that struggle.
const bframesInit = read("bframes-init.m4s");
const bframesFragment = read("bframes-1.m4s");
const withB = createProgressiveMp4(bframesInit);
withB.addFragment(
  (() => { const m = findBox(bframesFragment, ["moof"]); return bframesFragment.subarray(m.at, m.end); })(),
  (() => { const m = findBox(bframesFragment, ["mdat"]); return bframesFragment.subarray(m.at, m.end); })()
);
const bTables = withB.moov();
const ctts = findBox(bTables, ["moov", "trak", "mdia", "minf", "stbl", "ctts"]);
assert.ok(ctts, "a B-frame stream must state its composition offsets");
assert.equal(bTables[ctts.body], 0, "ctts must be version 0");

const cttsView = view(bTables);
const runs = cttsView.getUint32(ctts.body + 4);
let negative = 0;
let samples = 0;
for (let index = 0; index < runs; index += 1) {
  samples += cttsView.getUint32(ctts.body + 8 + index * 8);
  if (cttsView.getInt32(ctts.body + 8 + index * 8 + 4) < 0) negative += 1;
}
assert.equal(negative, 0, "version 0 offsets must all be non-negative");
assert.ok(runs < samples, "runs of equal offsets must be collapsed, not one entry per sample");

console.log("MP4 track merge check passed");
