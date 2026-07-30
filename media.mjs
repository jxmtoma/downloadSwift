const FILE_EXTENSIONS = new Set(["m4v", "mov", "mp4", "webm"]);
const PLAYLIST_EXTENSIONS = new Set(["m3u8", "mpd"]);
const PLAYLIST_MIMES = new Set([
  "application/dash+xml",
  "application/mpegurl",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl"
]);
const SEGMENT_EXTENSIONS = new Set(["aac", "cmfa", "cmfv", "m4s", "ts", "vtt"]);

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

export function detectMedia({ responseHeaders = [], type, url }) {
  if (!isSecureMediaUrl(url)) return null;
  if (blockedMediaHost(url)) return null;

  const { extension, name } = urlParts(url);
  if (SEGMENT_EXTENSIONS.has(extension)) return null;

  const mime = header(responseHeaders, "content-type").split(";", 1)[0].trim().toLowerCase();
  const rawSize = Number(header(responseHeaders, "content-length"));
  const size = Number.isSafeInteger(rawSize) && rawSize > 0 ? rawSize : null;

  if (PLAYLIST_EXTENSIONS.has(extension) || PLAYLIST_MIMES.has(mime)) {
    const format = extension === "mpd" || mime === "application/dash+xml" ? "DASH" : "HLS";
    return { format, kind: "playlist", mime, name, size };
  }

  if (FILE_EXTENSIONS.has(extension) || (type === "media" && mime.startsWith("video/"))) {
    const format = extension ? extension.toUpperCase() : mime.slice(6).toUpperCase();
    return { format, kind: "file", mime, name, size };
  }

  return null;
}
