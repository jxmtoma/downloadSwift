const FILE_EXTENSIONS = new Set(["m4v", "mov", "mp4", "webm"]);
const PLAYLIST_EXTENSIONS = new Set(["m3u8", "mpd"]);
const PLAYLIST_MIMES = new Set([
  "application/dash+xml",
  "application/mpegurl",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl"
]);
const SEGMENT_EXTENSIONS = new Set(["aac", "cmfa", "cmfv", "m4s", "ts", "vtt"]);
// Container mimes belong to whole files; these only ever label stream segments,
// which is the one thing an extensionless URL cannot tell us apart from a file.
const SEGMENT_MIMES = new Set([
  "video/iso.segment",
  "video/mp2t",
  "video/vnd.dlna.mpeg-tts"
]);
// Ad beacons, poster stubs, and player pings are served as video/mp4 too, and a
// page can emit several per real video. Nothing this small is a video anyone
// asked for, and a known size is the one cheap signal that separates them.
// ponytail: a floor only catches the obvious junk; rank by whether a <video>
// element loaded it if full-length ads start showing up.
const MIN_FILE_BYTES = 64 * 1024;

// The floor only clears out the junk that is obviously not a video. A page that
// offers hover-preview clips serves several real, playable MP4s per video, well
// over the floor, and they load after the video does — so a newest-first list
// put the previews above the thing being previewed. Ranking by size sinks them
// without hiding them, since a small file is still a file someone may have meant
// to download. A playlist states no size of its own and an unsized response
// keeps the same benefit of the doubt the floor gives it, so both rank with the
// largest file rather than at zero.
export const candidateRank = (item) => (
  item.kind === "playlist" || item.size == null ? Number.MAX_SAFE_INTEGER : item.size
);

// Variants differ in more than size: the codec decides whether the saved file
// will open at all. H.264 plays on everything. Macs have decoded HEVC in
// hardware since 2017. AV1 needs an M3 or newer, and macOS ships no software
// fallback, so an AV1 download plays back in the very browser that fetched it
// and then refuses to open in QuickTime — the file is perfect and unplayable.
// An unstated codec is not demoted: unknown is not the same as unplayable.
const CODEC_RANKS = [[/\bavc[13]\b/, 0], [/\b(hvc1|hev1)\b/, 1], [/\b(av01|vp0?9)\b/, 3]];
const codecRank = (codecs) => CODEC_RANKS.find(([codec]) => codec.test(codecs ?? ""))?.[1] ?? 2;

// Highest quality first, among the variants that will actually open. Quality
// still loses to playability: the picker lists every variant either way, so a
// deliberate choice of the sharper file is one click away.
export const byPlayability = (left, right) => (
  codecRank(left.codecs) - codecRank(right.codecs)
  || (right.bandwidth ?? 0) - (left.bandwidth ?? 0)
);

export function isSecureMediaUrl(rawUrl) {
  try {
    return new URL(rawUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function blockedMediaHost(rawUrl) {
  const hostname = new URL(rawUrl).hostname;
  return hostname === "youtu.be"
    || hostname === "youtube.com"
    || hostname.endsWith(".youtube.com")
    || hostname === "googlevideo.com"
    || hostname.endsWith(".googlevideo.com");
}

function safeFilenamePart(value) {
  const cleaned = String(value ?? "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `Video ${cleaned}`;
  return cleaned;
}

export function downloadFilename(pageTitle, item) {
  const nameExtension = item.name?.split(".").pop()?.toLowerCase();
  const formatExtension = item.format?.toLowerCase();
  const extension = FILE_EXTENSIONS.has(nameExtension)
    ? nameExtension
    : FILE_EXTENSIONS.has(formatExtension) ? formatExtension : "";
  const fallback = item.name?.replace(/\.[^.]+$/, "") || "video";
  const base = (safeFilenamePart(pageTitle) || safeFilenamePart(fallback) || "video").slice(0, 160);

  return extension && !base.toLowerCase().endsWith(`.${extension}`)
    ? `${base}.${extension}`
    : base;
}

function header(headers, name) {
  return headers.find((item) => item.name.toLowerCase() === name)?.value ?? "";
}

function urlParts(rawUrl) {
  const url = new URL(rawUrl);
  const encodedName = url.pathname.split("/").filter(Boolean).pop() ?? url.hostname;
  let name = encodedName;

  try {
    name = decodeURIComponent(encodedName);
  } catch {
    // Keep the encoded name when a site emits malformed percent escapes.
  }

  return {
    extension: name.includes(".") ? name.split(".").pop().toLowerCase() : "",
    name
  };
}

export function detectMedia({ responseHeaders = [], url }) {
  if (!isSecureMediaUrl(url)) return null;
  if (blockedMediaHost(url)) return null;

  const { extension, name } = urlParts(url);
  if (SEGMENT_EXTENSIONS.has(extension)) return null;

  const mime = header(responseHeaders, "content-type").split(";", 1)[0].trim().toLowerCase();
  // Some hosts disguise an HLS master as text/plain. Keep this deliberately
  // narrow: treating arbitrary .txt responses as playlists floods the popup.
  const textHlsMaster = extension === "txt"
    && name.toLowerCase() === "master.txt"
    && new URL(url).pathname.toLowerCase().includes("/hls/");
  // A 206 reports only the slice it returned, so a ranged request for a real
  // video looks tiny unless the total is read off content-range instead.
  const total = header(responseHeaders, "content-range").match(/\/\s*(\d+)\s*$/)?.[1];
  const rawSize = Number(total ?? header(responseHeaders, "content-length"));
  const size = Number.isSafeInteger(rawSize) && rawSize > 0 ? rawSize : null;

  if (textHlsMaster || PLAYLIST_EXTENSIONS.has(extension) || PLAYLIST_MIMES.has(mime)) {
    const format = extension === "mpd" || mime === "application/dash+xml" ? "DASH" : "HLS";
    // The response here is the manifest, so its length is the size of a text
    // file listing segments, not of the video. Reporting it made a two-hour
    // stream look like 29 KB. A real figure only exists once the stream is
    // resolved, which is where the estimate comes from.
    return { format, kind: "playlist", mime, name, size: null };
  }

  // Any request type, not just <video> loads: an embedded player usually pulls its
  // file over fetch or XHR, and those URLs often carry no extension at all.
  if (FILE_EXTENSIONS.has(extension) || (mime.startsWith("video/") && !SEGMENT_MIMES.has(mime))) {
    // Only when the size is actually known: an unsized response still gets the
    // benefit of the doubt, since plenty of real players send no length at all.
    if (size != null && size < MIN_FILE_BYTES) return null;
    const format = extension ? extension.toUpperCase() : mime.slice(6).toUpperCase();
    return { format, kind: "file", mime, name, size };
  }

  return null;
}
