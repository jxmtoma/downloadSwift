import { isSecureMediaUrl } from "./media.mjs";

// Wide enough to tell an ad card from a real scene at a glance, small enough
// that fifty of them fit in session storage without thought.
const PREVIEW_WIDTH = 160;
const DECODE_TIMEOUT = 8000;
const METADATA_TIMEOUT = 3000;

// Three lanes rather than one queue. An item always gets the same lane, so its
// own probe, size and thumbnail stay in order behind each other: the three share
// a redirect rule keyed by the item's URL, and two of them armed at once means
// one silently loses the rule and comes back empty. Different items sit in
// different lanes and run side by side. One queue for everything made the last
// row wait on every row above it — a thumbnail pulls a whole segment and decodes
// a frame — and no queue at all would have them fighting for the bandwidth the
// page is still using to play the video they came from.
//
// Each lane keeps the order things were asked for, and a render asks for every
// row's variants, then every row's size, then every row's thumbnail. So the
// cheap passes still finish first without anything having to sequence them.
const LANES = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
const itemLanes = new Map();

export function queueForItem(url, work) {
  if (!itemLanes.has(url)) itemLanes.set(url, itemLanes.size % LANES.length);
  const lane = itemLanes.get(url);
  const chain = LANES[lane].then(() => work());
  // The lane carries on after a failure; the caller still sees the rejection.
  LANES[lane] = chain.catch(() => {});
  return chain;
}

const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    })
  ]);
};

// Decoding needs a same-origin source or the canvas is tainted and cannot be
// read back, so the bytes are fetched by the caller and handed over as a blob
// rather than pointing the element at the remote URL.
async function firstFrame(blob, createElement) {
  const url = URL.createObjectURL(blob);
  const video = createElement("video");

  try {
    video.muted = true;
    video.playsInline = true;
    // "metadata" is not enough: a frame has to be decoded before it can be drawn.
    video.preload = "auto";

    const ready = withTimeout(new Promise((resolve, reject) => {
      video.addEventListener("loadeddata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("undecodable")), { once: true });
    }), DECODE_TIMEOUT, "decode timeout");
    video.src = url;
    // Safari will not fetch a frame for a detached element until asked.
    video.load();
    await ready;

    // Opening frames are routinely a black fade-in, which tells the user nothing.
    const target = Math.min(1, (Number(video.duration) || 0) / 4);
    if (target > 0) {
      await withTimeout(new Promise((resolve, reject) => {
        video.addEventListener("seeked", resolve, { once: true });
        video.addEventListener("error", () => reject(new Error("seek failed")), { once: true });
        video.currentTime = target;
      }), DECODE_TIMEOUT, "seek timeout").catch(() => {});
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error("no video track");

    const canvas = createElement("canvas");
    canvas.width = PREVIEW_WIDTH;
    canvas.height = Math.max(1, Math.round(PREVIEW_WIDTH * (height / width)));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.6), height, width };
  } finally {
    video.removeAttribute("src");
    video.load?.();
    URL.revokeObjectURL(url);
  }
}

export async function firstFrameDataUrl(blob, createElement) {
  return (await firstFrame(blob, createElement)).dataUrl;
}

export async function videoDimensions(url, createElement) {
  const video = createElement("video");
  try {
    video.preload = "metadata";
    const ready = withTimeout(new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("undecodable")), { once: true });
    }), METADATA_TIMEOUT, "metadata timeout");
    video.src = url;
    video.load();
    await ready;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error("no video track");
    return { height, width };
  } finally {
    video.removeAttribute("src");
    video.load?.();
  }
}

// A preview is a nicety: every failure here is silent, because a missing
// thumbnail costs the user nothing and a thrown one would surface as an error
// for a download the user never asked for.
export async function makePreview(item, { createElement, fetchBytes }) {
  try {
    if (!isSecureMediaUrl(item?.url)) return { ok: false };
    const blob = await fetchBytes(item.url);
    if (!blob) return { ok: false };
    return { ...await firstFrame(blob, createElement), ok: true };
  } catch {
    return { ok: false };
  }
}
