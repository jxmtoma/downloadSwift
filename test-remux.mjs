import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createTsTransmuxer, finalizeMp4Duration } from "./hls.mjs";

const sandbox = { globalThis: null, self: null, window: {} };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.runInNewContext(fs.readFileSync("vendor/mux-mp4.min.js", "utf8"), sandbox);

const transmux = createTsTransmuxer(sandbox.muxjs);
const [chunk] = transmux(new Uint8Array(fs.readFileSync("test-fixtures/h264-aac.ts")));
const output = Buffer.concat([Buffer.from(chunk.initSegment), Buffer.from(chunk.data)]);

assert.equal(output.subarray(4, 8).toString(), "ftyp");
assert.ok(output.includes(Buffer.from("moov")));
assert.ok(output.includes(Buffer.from("moof")));
assert.ok(output.includes(Buffer.from("mdat")));

const durationSeconds = 12.5;
const finalized = Buffer.from(finalizeMp4Duration(
  chunk.initSegment,
  durationSeconds,
  sandbox.muxjs
));
const mvhdType = finalized.indexOf(Buffer.from("mvhd"));
const timescale = finalized.readUInt32BE(mvhdType + 16);
const duration = finalized.readUInt32BE(mvhdType + 20);
assert.equal(Buffer.from(chunk.initSegment).readUInt32BE(mvhdType + 20), 0xffffffff);
assert.equal(duration / timescale, durationSeconds);

console.log("TS-to-MP4 transmux check passed");
