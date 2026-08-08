// A minimal ISO-BMFF box walker. mux.js only reads boxes; combining two
// fragmented streams means rewriting a few fields, which needs full box extents.

const boxType = (bytes, at) => String.fromCharCode(
  bytes[at + 4],
  bytes[at + 5],
  bytes[at + 6],
  bytes[at + 7]
);

export function* boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;

  while (at + 8 <= end) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) return;
    yield { at, body: at + header, end: at + size, type: size ? boxType(bytes, at) : "" };
    at += size;
  }
}

export function findBox(bytes, path, start = 0, end = bytes.length) {
  const [head, ...rest] = path;
  for (const box of boxes(bytes, start, end)) {
    if (box.type !== head) continue;
    return rest.length ? findBox(bytes, rest, box.body, box.end) : box;
  }
  return null;
}

const slice = (bytes, box) => bytes.subarray(box.at, box.end);

function fullBoxVersion(bytes, box) {
  return bytes[box.body];
}

// tkhd: version/flags, then creation and modification (4 or 8 bytes each),
// then the track ID.
function trackIdOffset(bytes, box) {
  return box.body + (fullBoxVersion(bytes, box) === 1 ? 20 : 12);
}

function writeUint32(bytes, at, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(at, value);
}

export function readTrackId(bytes) {
  const tkhd = findBox(bytes, ["moov", "trak", "tkhd"]);
  return tkhd ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(trackIdOffset(bytes, tkhd)) : 0;
}

// Both streams of a DASH pair are authored independently, so both normally call
// themselves track 1. One of them has to be renumbered, in its header, in its
// trex default, and in every fragment that refers to it.
function renumberTrak(trak, id) {
  const copy = new Uint8Array(trak);
  // The slice still carries its own trak header, so the path starts there: a
  // bare ["tkhd"] matches nothing and renumbers nothing, which leaves the moov
  // claiming a track id its own fragments no longer use.
  const tkhd = findBox(copy, ["trak", "tkhd"]);
  if (!tkhd) throw new Error("track header not found");
  writeUint32(copy, trackIdOffset(copy, tkhd), id);
  return copy;
}

function renumberTrex(trex, id) {
  const copy = new Uint8Array(trex);
  writeUint32(copy, 8 + 4, id);
  return copy;
}

// tfhd carries the track ID a fragment belongs to; mfhd carries a sequence
// number that has to keep climbing once two streams are interleaved.
export function renumberFragment(fragment, id, sequence) {
  const copy = new Uint8Array(fragment);
  const mfhd = findBox(copy, ["moof", "mfhd"]);
  if (mfhd) writeUint32(copy, mfhd.body + 4, sequence);
  const moof = findBox(copy, ["moof"]);
  if (moof) {
    for (const traf of boxes(copy, moof.body, moof.end)) {
      if (traf.type !== "traf") continue;
      const tfhd = findBox(copy, ["tfhd"], traf.body, traf.end);
      if (tfhd) writeUint32(copy, tfhd.body + 4, id);
    }
  }
  return copy;
}

// A DASH SegmentBase stream is one whole fragmented file per track rather than
// a list of segment URLs, and those files run to hundreds of megabytes. This
// hands back complete top-level boxes as the bytes arrive so a track can be
// rewritten and written out without ever being held in memory.
export function createBoxSplitter() {
  // Chunks are held as they arrive and only joined once a whole box is present.
  // Concatenating on every push instead is quadratic, and an mdat is megabytes
  // arriving in tens-of-kilobytes pieces.
  let pending = [];
  let held = 0;

  const take = (length) => {
    const out = new Uint8Array(length);
    let at = 0;
    while (at < length) {
      const chunk = pending[0];
      const wanted = Math.min(chunk.length, length - at);
      out.set(chunk.subarray(0, wanted), at);
      at += wanted;
      if (wanted === chunk.length) pending.shift();
      else pending[0] = chunk.subarray(wanted);
    }
    held -= length;
    return out;
  };

  const peek = (length) => {
    const out = new Uint8Array(length);
    let at = 0;
    for (const chunk of pending) {
      if (at >= length) break;
      const wanted = Math.min(chunk.length, length - at);
      out.set(chunk.subarray(0, wanted), at);
      at += wanted;
    }
    return out;
  };

  return (chunk) => {
    if (chunk.length) {
      pending.push(chunk);
      held += chunk.length;
    }

    const ready = [];
    while (held >= 8) {
      const header = peek(16);
      const view = new DataView(header.buffer);
      let size = view.getUint32(0);
      if (size === 1) {
        if (held < 16) break;
        size = Number(view.getBigUint64(8));
      }
      if (size < 8 || held < size) break;
      const bytes = take(size);
      ready.push({ bytes, type: boxType(bytes, 0) });
    }
    return ready;
  };
}

// A fragment states where it starts on its own track's clock, which is what
// decides the order two tracks are written in.
export function fragmentStartTime(moof) {
  const tfdt = findBox(moof, ["moof", "traf", "tfdt"]);
  if (!tfdt) return 0;
  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  return moof[tfdt.body] === 1
    ? Number(view.getBigUint64(tfdt.body + 4))
    : view.getUint32(tfdt.body + 4);
}

export function readTimescale(initSegment) {
  const mdhd = findBox(initSegment, ["moov", "trak", "mdia", "mdhd"]);
  if (!mdhd) return 1;
  const view = new DataView(initSegment.buffer, initSegment.byteOffset, initSegment.byteLength);
  return view.getUint32(mdhd.body + (initSegment[mdhd.body] === 1 ? 20 : 12)) || 1;
}

const box = (type, ...payloads) => {
  const length = payloads.reduce((total, part) => total + part.length, 8);
  const result = new Uint8Array(length);
  writeUint32(result, 0, length);
  result.set([...type].map((character) => character.charCodeAt(0)), 4);
  let at = 8;
  for (const part of payloads) {
    result.set(part, at);
    at += part.length;
  }
  return result;
};

// Builds one initialisation segment declaring both tracks, so a player sees a
// single movie with video and audio rather than two unrelated files.
// Without mehd a fragmented movie declares no length at all, and a player is
// left to guess one from whichever fragment it happens to see last, which comes
// out wrong as soon as two tracks with different timescales are interleaved.
function movieExtendsHeader(seconds, timescale) {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setUint8(0, 1);
  view.setBigUint64(4, BigInt(Math.max(0, Math.round(seconds * timescale))));
  return box("mehd", payload);
}

export function combineInitSegments(videoInit, audioInit, durationSeconds = 0) {
  const videoTrackId = readTrackId(videoInit) || 1;
  const audioTrackId = videoTrackId === 1 ? 2 : 1;

  const ftyp = findBox(videoInit, ["ftyp"]);
  const mvhd = findBox(videoInit, ["moov", "mvhd"]);
  const videoTrak = findBox(videoInit, ["moov", "trak"]);
  const audioTrak = findBox(audioInit, ["moov", "trak"]);
  const videoTrex = findBox(videoInit, ["moov", "mvex", "trex"]);
  const audioTrex = findBox(audioInit, ["moov", "mvex", "trex"]);
  if (!mvhd || !videoTrak || !audioTrak) throw new Error("missing track headers");

  const mvhdBytes = new Uint8Array(slice(videoInit, mvhd));
  // next_track_ID sits at the end of mvhd; 0xffffffff means "work it out", which
  // is the honest answer once two independently authored tracks are merged.
  writeUint32(mvhdBytes, mvhdBytes.length - 4, 0xffffffff);

  const movieTimescale = new DataView(
    mvhdBytes.buffer,
    mvhdBytes.byteOffset,
    mvhdBytes.byteLength
  ).getUint32(mvhdBytes[8] === 1 ? 28 : 20);

  const mvex = box(
    "mvex",
    durationSeconds > 0 ? movieExtendsHeader(durationSeconds, movieTimescale) : new Uint8Array(),
    videoTrex ? renumberTrex(slice(videoInit, videoTrex), videoTrackId) : new Uint8Array(),
    audioTrex ? renumberTrex(slice(audioInit, audioTrex), audioTrackId) : new Uint8Array()
  );
  const moov = box(
    "moov",
    mvhdBytes,
    renumberTrak(slice(videoInit, videoTrak), videoTrackId),
    renumberTrak(slice(audioInit, audioTrak), audioTrackId),
    mvex
  );

  return {
    audioTrackId,
    initSegment: ftyp
      ? new Uint8Array([...slice(videoInit, ftyp), ...moov])
      : moov,
    videoTrackId
  };
}

// ---------------------------------------------------------------------------
// Fragmented to progressive
//
// A fragmented MP4 states where its samples are in a moof before each chunk of
// data. macOS does not read that layout from a file at all: AVFoundation and
// CoreAudio report zero packets and zero duration, so the file plays broken in
// every browser on the platform while Windows plays it correctly. A progressive
// file states everything once, in sample tables inside moov, and both read it.

const readTrun = (bytes, traf, defaults) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tfhd = findBox(bytes, ["tfhd"], traf.body, traf.end);
  const tfhdFlags = view.getUint32(tfhd.body) & 0xffffff;
  let at = tfhd.body + 8;
  if (tfhdFlags & 0x01) at += 8;
  if (tfhdFlags & 0x02) at += 4;
  const sampleDuration = tfhdFlags & 0x08 ? view.getUint32((at += 4) - 4) : defaults.duration;
  const sampleSize = tfhdFlags & 0x10 ? view.getUint32((at += 4) - 4) : defaults.size;
  const sampleFlags = tfhdFlags & 0x20 ? view.getUint32((at += 4) - 4) : defaults.flags;

  const samples = [];
  let dataOffset = 0;
  for (const trun of boxes(bytes, traf.body, traf.end)) {
    if (trun.type !== "trun") continue;
    const flags = view.getUint32(trun.body) & 0xffffff;
    const count = view.getUint32(trun.body + 4);
    let cursor = trun.body + 8;
    if (flags & 0x001) dataOffset = view.getInt32((cursor += 4) - 4);
    const firstFlags = flags & 0x004 ? view.getUint32((cursor += 4) - 4) : null;

    for (let index = 0; index < count; index += 1) {
      const duration = flags & 0x100 ? view.getUint32((cursor += 4) - 4) : sampleDuration;
      const size = flags & 0x200 ? view.getUint32((cursor += 4) - 4) : sampleSize;
      const ownFlags = flags & 0x400 ? view.getUint32((cursor += 4) - 4) : sampleFlags;
      // Signed: a frame can be composed before the one it is coded after.
      const composition = flags & 0x800 ? view.getInt32((cursor += 4) - 4) : 0;
      const effective = index === 0 && firstFlags !== null ? firstFlags : ownFlags;
      samples.push({ composition, duration, size, sync: !(effective & 0x10000) });
    }
  }
  return { dataOffset, samples };
};

// stsz, stts and the rest are all run-length or flat lists of 32-bit fields.
const table = (type, version, entries, width) => {
  const payload = new Uint8Array(8 + entries.length * width * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(0, version << 24);
  view.setUint32(4, entries.length);
  entries.forEach((entry, index) => {
    [entry].flat().forEach((value, field) => {
      view.setUint32(8 + (index * width + field) * 4, value);
    });
  });
  return box(type, payload);
};

function sampleTables(samples, offsets) {
  const durations = [];
  for (const { duration } of samples) {
    const last = durations.at(-1);
    if (last && last[1] === duration) last[0] += 1;
    else durations.push([1, duration]);
  }

  const sizes = new Uint8Array(12 + samples.length * 4);
  const sizeView = new DataView(sizes.buffer);
  sizeView.setUint32(4, 0);
  sizeView.setUint32(8, samples.length);
  samples.forEach((sample, index) => sizeView.setUint32(12 + index * 4, sample.size));

  const children = [
    table("stts", 0, durations, 2),
    box("stsz", sizes),
    // One chunk per fragment, so the run-length collapses to however many
    // distinct samples-per-chunk values the fragments happened to use.
    table("stsc", 0, offsets.map((chunk, index) => [index + 1, chunk.count, 1]), 3),
    table("co64", 0, offsets.map((chunk) => [
      Math.floor(chunk.offset / 2 ** 32),
      chunk.offset >>> 0
    ]), 2)
  ];

  const syncs = samples.flatMap((sample, index) => (sample.sync ? [index + 1] : []));
  if (syncs.length && syncs.length !== samples.length) children.push(table("stss", 0, syncs, 1));
  // ctts version 0, with every offset shifted non-negative. Version 1's signed
  // offsets are read far less reliably — QuickTime among the readers that
  // struggle — and a constant shift moves decode and presentation apart by the
  // same amount for every sample, which changes nothing anyone can see. Run
  // lengths matter too: one entry per sample is megabytes on a long video.
  const compositions = samples.map((sample) => sample.composition);
  if (compositions.some((offset) => offset !== 0)) {
    const shift = Math.min(0, ...compositions);
    const runs = [];
    for (const offset of compositions) {
      const value = offset - shift;
      const last = runs.at(-1);
      if (last && last[1] === value) last[0] += 1;
      else runs.push([1, value]);
    }
    children.push(table("ctts", 0, runs, 2));
  }
  return children;
}

// Swapping a box for a bigger one invalidates the size of every box enclosing
// it, so each ancestor is rebuilt rather than patched in place. Splicing the new
// sample tables in without this left every trak claiming its old length, and a
// player read one truncated track and lost the other entirely.
function rebuildPath(bytes, path, replacement) {
  const [head, ...rest] = path;
  const target = findBox(bytes, [head]);
  if (!target) return bytes;
  if (!rest.length) return replacement;

  const parts = [];
  for (const child of boxes(bytes, target.body, target.end)) {
    parts.push(child.type === rest[0]
      ? rebuildPath(slice(bytes, child), rest, replacement)
      : slice(bytes, child));
  }
  return box(head, ...parts);
}

// readTimescale expects a whole init segment; a bare trak has no moov above it.
function trakTimescale(trak) {
  const mdhd = findBox(trak, ["trak", "mdia", "mdhd"]);
  if (!mdhd) return 1;
  const view = new DataView(trak.buffer, trak.byteOffset, trak.byteLength);
  return view.getUint32(mdhd.body + (trak[mdhd.body] === 1 ? 20 : 12)) || 1;
}

const writeDuration = (bytes, at, version, seconds, timescale) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = Math.max(0, Math.round(seconds * timescale));
  if (version === 1) view.setBigUint64(at, BigInt(value));
  else view.setUint32(at, Math.min(value, 0xfffffffe));
};

// Consumes the same init segment and moof/mdat pairs the fragmented path
// produces, and yields the bytes of a progressive file instead.
export function createProgressiveMp4(initSegment) {
  const view = new DataView(initSegment.buffer, initSegment.byteOffset, initSegment.byteLength);
  const moov = findBox(initSegment, ["moov"]);
  const tracks = new Map();

  for (const trak of boxes(initSegment, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    const tkhd = findBox(initSegment, ["tkhd"], trak.body, trak.end);
    const id = view.getUint32(tkhd.body + (initSegment[tkhd.body] === 1 ? 20 : 12));
    tracks.set(id, {
      bytes: slice(initSegment, trak),
      chunks: [],
      defaults: { duration: 0, flags: 0, size: 0 },
      samples: [],
      timescale: trakTimescale(slice(initSegment, trak))
    });
  }

  const mvex = findBox(initSegment, ["moov", "mvex"]);
  if (mvex) {
    for (const trex of boxes(initSegment, mvex.body, mvex.end)) {
      if (trex.type !== "trex") continue;
      const track = tracks.get(view.getUint32(trex.body + 4));
      if (!track) continue;
      track.defaults = {
        duration: view.getUint32(trex.body + 12),
        flags: view.getUint32(trex.body + 20),
        size: view.getUint32(trex.body + 16)
      };
    }
  }

  // ftyp first. A file that opens with mdat is still readable by ffmpeg, but
  // QuickTime and everything else on macOS use the brand to decide what the file
  // even is, and reject it outright without one.
  const ftypBox = findBox(initSegment, ["ftyp"]);
  const ftyp = ftypBox
    ? slice(initSegment, ftypBox)
    : box("ftyp", new Uint8Array([
      0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
      0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31
    ]));

  // mdat follows it and its size is patched once the total is known, so the
  // sample offsets recorded here are already the ones the tables will state.
  const MDAT_HEADER = 16;
  const prefixSize = ftyp.length + MDAT_HEADER;
  let position = prefixSize;

  return {
    // Everything that precedes the media: written as a placeholder up front and
    // rewritten by header() once the length is known.
    prefixSize,

    // Returns exactly the sample bytes to append, in decode order.
    addFragment(moof, mdat) {
      const source = new Uint8Array(moof.length + mdat.length);
      source.set(moof);
      source.set(mdat, moof.length);
      const sourceView = new DataView(source.buffer);
      const moofBox = findBox(source, ["moof"]);
      const parts = [];

      for (const traf of boxes(source, moofBox.body, moofBox.end)) {
        if (traf.type !== "traf") continue;
        const id = sourceView.getUint32(findBox(source, ["tfhd"], traf.body, traf.end).body + 4);
        const track = tracks.get(id);
        if (!track) continue;

        const { dataOffset, samples } = readTrun(source, traf, track.defaults);
        // Offsets in a fragment are relative to the moof, which is why the two
        // boxes are read as one buffer rather than only the payload.
        let at = dataOffset;
        track.chunks.push({ count: samples.length, offset: position });
        for (const sample of samples) {
          parts.push(source.subarray(at, at + sample.size));
          at += sample.size;
          position += sample.size;
          track.samples.push(sample);
        }
      }

      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const out = new Uint8Array(total);
      let cursor = 0;
      for (const part of parts) {
        out.set(part, cursor);
        cursor += part.length;
      }
      return out;
    },

    // ftyp plus the mdat header, once the payload length is known.
    header() {
      const mdat = new Uint8Array(MDAT_HEADER);
      const mdatView = new DataView(mdat.buffer);
      mdatView.setUint32(0, 1);
      mdat.set([109, 100, 97, 116], 4);
      mdatView.setBigUint64(8, BigInt(MDAT_HEADER + position - prefixSize));
      return new Uint8Array([...ftyp, ...mdat]);
    },

    // The finished moov, to append after the media.
    moov() {
      const movieTimescale = view.getUint32(
        findBox(initSegment, ["moov", "mvhd"]).body
        + (initSegment[findBox(initSegment, ["moov", "mvhd"]).body] === 1 ? 20 : 12)
      );
      let longest = 0;
      const traks = [];

      for (const track of tracks.values()) {
        if (!track.samples.length) continue;
        const ticks = track.samples.reduce((sum, sample) => sum + sample.duration, 0);
        const seconds = ticks / track.timescale;
        longest = Math.max(longest, seconds);

        const trak = new Uint8Array(track.bytes);
        const tkhd = findBox(trak, ["trak", "tkhd"]);
        writeDuration(trak, tkhd.body + (trak[tkhd.body] === 1 ? 28 : 20), trak[tkhd.body], seconds, movieTimescale);
        const mdhd = findBox(trak, ["trak", "mdia", "mdhd"]);
        writeDuration(trak, mdhd.body + (trak[mdhd.body] === 1 ? 24 : 16), trak[mdhd.body], seconds, track.timescale);

        // Everything above stbl is kept as authored; only the sample tables,
        // which a fragmented file leaves empty, are rebuilt.
        const stbl = findBox(trak, ["trak", "mdia", "minf", "stbl"]);
        const stsd = findBox(trak, ["stsd"], stbl.body, stbl.end);
        const rebuilt = box("stbl", slice(trak, stsd), ...sampleTables(track.samples, track.chunks));
        traks.push(rebuildPath(trak, ["trak", "mdia", "minf", "stbl"], rebuilt));
      }

      const mvhd = new Uint8Array(slice(initSegment, findBox(initSegment, ["moov", "mvhd"])));
      writeDuration(mvhd, 8 + (mvhd[8] === 1 ? 24 : 16), mvhd[8], longest, movieTimescale);
      // No mvex: there are no fragments left for it to describe.
      return box("moov", mvhd, ...traks);
    }
  };
}
