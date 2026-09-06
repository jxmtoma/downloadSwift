import { byPlayability } from "./media.mjs";
import { t } from "./i18n.mjs";

function attributes(line) {
  const values = new Map();
  const matcher = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;

  while ((match = matcher.exec(line))) {
    values.set(match[1], match[2].replace(/^"|"$/g, ""));
  }

  return values;
}

function playlistLines(text) {
  const lines = text.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error(t("error_not_hls"));
  return lines;
}

function writeMp4Duration(view, box, type, seconds, timescale) {
  const start = box.byteOffset - view.byteOffset;
  const version = box[0];
  const relativeOffset = type === "tkhd"
    ? version === 1 ? 28 : 20
    : type === "mehd" ? 4
      : version === 1 ? 24 : 16;
  const offset = start + relativeOffset;
  const duration = Math.max(1, Math.round(seconds * timescale));

  if (version === 1) {
    view.setUint32(offset, Math.floor(duration / (2 ** 32)));
    view.setUint32(offset + 4, duration >>> 0);
  } else {
    view.setUint32(offset, Math.min(duration, 0xfffffffe));
  }
}

export function finalizeMp4Duration(initSegment, durationSeconds, muxjs) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return initSegment;

  const bytes = new Uint8Array(initSegment);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const findBox = (path) => muxjs.probe.findBox(bytes, path);
  const [mvhd] = findBox(["moov", "mvhd"]);
  if (!mvhd) return bytes;
  const movieStart = mvhd.byteOffset - view.byteOffset;
  const movieTimescale = view.getUint32(movieStart + (mvhd[0] === 1 ? 20 : 12));
  writeMp4Duration(view, mvhd, "mvhd", durationSeconds, movieTimescale);

  for (const tkhd of findBox(["moov", "trak", "tkhd"])) {
    writeMp4Duration(view, tkhd, "tkhd", durationSeconds, movieTimescale);
  }
  for (const mdhd of findBox(["moov", "trak", "mdia", "mdhd"])) {
    const start = mdhd.byteOffset - view.byteOffset;
    const timescale = view.getUint32(start + (mdhd[0] === 1 ? 20 : 12));
    writeMp4Duration(view, mdhd, "mdhd", durationSeconds, timescale);
  }
  for (const mehd of findBox(["moov", "mvex", "mehd"])) {
    writeMp4Duration(view, mehd, "mehd", durationSeconds, movieTimescale);
  }
  return bytes;
}

export function parseHlsVariants(text, baseUrl) {
  const lines = playlistLines(text);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) continue;
    const values = attributes(lines[index]);
    const uri = lines.slice(index + 1).find((line) => !line.startsWith("#"));
    if (!uri) continue;
    variants.push({
      audioGroup: values.get("AUDIO"),
      bandwidth: Number(values.get("BANDWIDTH")) || 0,
      codecs: values.get("CODECS"),
      index: variants.length,
      resolution: values.get("RESOLUTION"),
      subtitleGroup: values.get("SUBTITLES"),
      url: new URL(uri, baseUrl).href
    });
  }

  return variants;
}

// One lookup serves audio and subtitles: both are EXT-X-MEDIA renditions of a
// variant's group, and both prefer the rendition marked DEFAULT.
function hlsMediaUrl(lines, type, groupId, baseUrl) {
  if (!groupId) return null;
  const tracks = lines
    .filter((line) => line.startsWith("#EXT-X-MEDIA:"))
    .map((line) => attributes(line))
    .filter((values) => values.get("TYPE") === type
      && values.get("GROUP-ID") === groupId
      && values.has("URI"))
    .sort((left, right) => Number(right.get("DEFAULT") === "YES")
      - Number(left.get("DEFAULT") === "YES"));
  return tracks[0]?.get("URI") ? new URL(tracks[0].get("URI"), baseUrl).href : null;
}

export function selectHlsVariant(text, baseUrl, selectedUrl, selectedIndex) {
  const lines = playlistLines(text);
  const variants = parseHlsVariants(text, baseUrl);

  if (!variants.length) return { bandwidth: 0, url: baseUrl };

  const selected = variants.find((variant) => variant.url === selectedUrl)
    ?? (Number.isInteger(selectedIndex) ? variants[selectedIndex] : null)
    ?? [...variants].sort(byPlayability)[0];
  const audioUrl = hlsMediaUrl(lines, "AUDIO", selected.audioGroup, baseUrl);
  const subtitleUrl = hlsMediaUrl(lines, "SUBTITLES", selected.subtitleGroup, baseUrl);

  return {
    ...audioUrl ? { audioUrl } : {},
    ...subtitleUrl ? { subtitleUrl } : {},
    bandwidth: selected.bandwidth,
    url: selected.url
  };
}

// Byte-range segments are slices of one resource, addressed by a length and an
// offset (RFC 8216 §4.3.2.2). An offset that is absent chains from the previous
// segment's end, and the first segment starts at zero.
const BYTE_RANGE_VALUE = /^(\d+)(?:@(\d+))?$/;

function byteRange(length, offset, implicitOffset) {
  const start = offset ?? implicitOffset;
  return { end: start + length - 1, start };
}

// The exact request a byte-range segment needs.
export const rangeHeader = (range) => `bytes=${range.start}-${range.end}`;

export function parseHlsMedia(text, baseUrl) {
  const lines = playlistLines(text);
  if (!lines.includes("#EXT-X-ENDLIST")) {
    throw new Error(t("error_live_hls"));
  }
  const hasByteRanges = lines.some((line) => line.startsWith("#EXT-X-BYTERANGE:"));
  // Segments of one resource have to sit inside a single continuous encoding:
  // a discontinuity or a second initialization segment would produce a file
  // whose sample tables describe media the bytes no longer match.
  if (hasByteRanges && lines.some((line) => line.startsWith("#EXT-X-DISCONTINUITY"))) {
    throw new Error(t("error_byte_range_hls"));
  }
  if (hasByteRanges && lines.filter((line) => line.startsWith("#EXT-X-MAP:")).length > 1) {
    throw new Error(t("error_byte_range_hls"));
  }
  if (lines.some((line) => {
    if (!line.startsWith("#EXT-X-KEY:")) return false;
    return attributes(line).get("METHOD") !== "NONE";
  })) {
    throw new Error(t("error_encrypted_hls"));
  }

  const mapLine = lines.find((line) => line.startsWith("#EXT-X-MAP:"));
  const mapValues = mapLine ? attributes(mapLine) : null;

  // EXTINF precedes its segment, so one pass pairs each duration with its URL.
  // The durations let subtitle segments be re-timestamped as they are joined.
  const byteRangeTag = "#EXT-X-BYTERANGE:";
  let pendingDuration = 0;
  let pendingRange = null;
  let implicitOffset = 0;
  const segmentUrls = [];
  const segmentDurations = [];
  const segmentRanges = [];
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number.parseFloat(line.slice(8)) || 0;
      continue;
    }
    if (line.startsWith(byteRangeTag)) {
      const match = BYTE_RANGE_VALUE.exec(line.slice(byteRangeTag.length));
      if (!match) continue;
      pendingRange = { length: Number(match[1]), offset: match[2] == null ? undefined : Number(match[2]) };
      continue;
    }
    if (line.startsWith("#")) continue;
    segmentUrls.push(new URL(line, baseUrl).href);
    segmentDurations.push(pendingDuration);
    pendingDuration = 0;
    let range = null;
    if (pendingRange) {
      range = byteRange(pendingRange.length, pendingRange.offset, implicitOffset);
      implicitOffset = range.end + 1;
    } else {
      // A segment that is a whole resource resets the implicit chain; the next
      // ranged segment starts from that resource's beginning.
      implicitOffset = 0;
    }
    pendingRange = null;
    segmentRanges.push(range);
  }
  if (!segmentUrls.length) throw new Error(t("error_no_segments"));

  const initUrl = mapValues?.get("URI")
    ? new URL(mapValues.get("URI"), baseUrl).href
    : null;
  const mapRange = mapValues?.get("BYTERANGE")
    ? BYTE_RANGE_VALUE.exec(mapValues.get("BYTERANGE"))
    : null;
  const initRange = mapRange
    ? byteRange(Number(mapRange[1]), mapRange[2] == null ? undefined : Number(mapRange[2]), 0)
    : undefined;
  const extension = initUrl || segmentUrls.some((url) => /\.(m4s|mp4)(?:$|\?)/i.test(url))
    ? "mp4"
    : "ts";
  const durationSeconds = segmentDurations.reduce((total, seconds) => total + seconds, 0);

  return {
    durationSeconds,
    extension,
    ...initRange ? { initRange } : {},
    initUrl,
    segmentDurations,
    ...segmentRanges.some(Boolean) ? { segmentRanges } : {},
    segmentUrls
  };
}

export function createTsTransmuxer(muxjs) {
  const Transmuxer = muxjs.mp4?.Transmuxer ?? muxjs.Transmuxer;
  const transmuxer = new Transmuxer({ remux: true });
  let chunks = [];
  transmuxer.on("data", (chunk) => chunks.push(chunk));

  return (bytes) => {
    chunks = [];
    transmuxer.push(bytes);
    transmuxer.flush();
    if (!chunks.length) {
      throw new Error(t("error_unsupported_ts"));
    }
    return chunks;
  };
}

const VTT_TIMESTAMPS = /(\d{2,}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const VTT_MPEGTS_TIMESCALE = 90000;

function parseVttSeconds(text) {
  const match = VTT_TIMESTAMPS.exec(text);
  if (!match) return null;
  const [, hours = "0", minutes, seconds, fraction] = match;
  return Number(hours.replace(":", "")) * 3600 + Number(minutes) * 60
    + Number(seconds) + Number(fraction.padEnd(3, "0")) / 1000;
}

function formatVttSeconds(seconds) {
  const clamped = Math.max(0, seconds);
  const whole = Math.floor(clamped);
  const pad = (value, width) => String(value).padStart(width, "0");
  return `${pad(Math.floor(whole / 3600), 2)}:${pad(Math.floor(whole / 60) % 60, 2)}:${pad(whole % 60, 2)}.${pad(Math.round((clamped - whole) * 1000) % 1000, 3)}`;
}

function vttTimestampMap(lines) {
  const line = lines.find((entry) => entry.startsWith("X-TIMESTAMP-MAP:"));
  if (!line) return null;
  const local = parseVttSeconds(line.slice(line.indexOf("LOCAL:") + 6, line.indexOf(",")));
  const mpegts = Number(/MPEGTS:(\d+)/.exec(line)?.[1]);
  if (local == null || !Number.isFinite(mpegts)) return null;
  // Where the segment's local zero sits on the presentation timeline.
  return mpegts / VTT_MPEGTS_TIMESCALE - local;
}

function* vttCues(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const [startText, tail] = lines[index].split("-->");
    if (tail === undefined) continue;
    const start = parseVttSeconds(startText);
    if (start == null) continue;

    const tailTrimmed = tail.trim();
    const endMatch = VTT_TIMESTAMPS.exec(tailTrimmed);
    if (!endMatch || endMatch.index !== 0) continue;
    const end = parseVttSeconds(endMatch[0]);

    const text = [];
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor]) {
      text.push(lines[cursor]);
      cursor += 1;
    }
    // Cue identifiers are dropped: the timestamps and text are what a player reads.
    index = cursor;
    yield {
      end,
      settings: tailTrimmed.slice(endMatch[0].length).trim(),
      start,
      text
    };
  }
}

// Each HLS subtitle segment is a complete WebVTT file whose cue timestamps are
// relative to that segment (or mapped onto the presentation timeline with
// X-TIMESTAMP-MAP). One continuous file is what a sidecar has to be, so every
// cue is re-timestamped onto a single timeline and the cues a player carries
// over a segment boundary are written once.
export function combineVttSegments(segments, durations = []) {
  const cues = [];
  const seen = new Set();
  let firstOffset = null;

  segments.forEach((segment, index) => {
    const lines = segment.replace(/\r/g, "").split("\n").map((line) => line.trim());
    const mapOffset = vttTimestampMap(lines);
    const fallbackOffset = durations.slice(0, index).reduce((total, seconds) => total + seconds, 0);

    for (const cue of vttCues(lines)) {
      const offset = mapOffset ?? fallbackOffset;
      const start = cue.start + offset;
      const end = cue.end + offset;
      const key = `${start}|${end}|${cue.text.join("\n")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // The first cue fixes the timeline's zero: MPEGTS carries an arbitrary
      // PCR base, and the downloaded video's zero is the stream's own start.
      if (firstOffset == null) firstOffset = offset;
      cues.push({
        settings: cue.settings,
        text: cue.text,
        times: `${formatVttSeconds(start - firstOffset)} --> ${formatVttSeconds(end - firstOffset)}`
      });
    }
  });

  return ["WEBVTT", "", ...cues.flatMap((cue) => (
    [cue.times + (cue.settings ? ` ${cue.settings}` : ""), ...cue.text, ""]
  ))].join("\n");
}
