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

export function selectHlsVariant(text, baseUrl) {
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
      url: new URL(uri, baseUrl).href
    });
  }

  if (!variants.length) return { url: baseUrl };

  const selected = variants.sort((left, right) => right.bandwidth - left.bandwidth)[0];
  if (selected.audioGroup) {
    const separateAudio = lines.some((line) => {
      if (!line.startsWith("#EXT-X-MEDIA:")) return false;
      const values = attributes(line);
      return values.get("TYPE") === "AUDIO"
        && values.get("GROUP-ID") === selected.audioGroup
        && values.has("URI");
    });
    if (separateAudio) throw new Error(t("error_separate_audio"));
  }

  return { url: selected.url };
}

export function parseHlsMedia(text, baseUrl) {
  const lines = playlistLines(text);
  if (!lines.includes("#EXT-X-ENDLIST")) {
    throw new Error(t("error_live_hls"));
  }
  if (lines.some((line) => line.startsWith("#EXT-X-BYTERANGE"))) {
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
  if (mapValues?.has("BYTERANGE")) {
    throw new Error(t("error_byte_range_hls"));
  }

  const segmentUrls = lines
    .filter((line) => !line.startsWith("#"))
    .map((line) => new URL(line, baseUrl).href);
  if (!segmentUrls.length) throw new Error(t("error_no_segments"));

  const initUrl = mapValues?.get("URI")
    ? new URL(mapValues.get("URI"), baseUrl).href
    : null;
  const extension = initUrl || segmentUrls.some((url) => /\.(m4s|mp4)(?:$|\?)/i.test(url))
    ? "mp4"
    : "ts";
  const durationSeconds = lines
    .filter((line) => line.startsWith("#EXTINF:"))
    .reduce((total, line) => total + (Number.parseFloat(line.slice(8)) || 0), 0);

  return { durationSeconds, extension, initUrl, segmentUrls };
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
