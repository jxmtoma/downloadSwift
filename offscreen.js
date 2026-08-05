import {
  createTsTransmuxer,
  finalizeMp4Duration,
  parseHlsMedia,
  selectHlsVariant
} from "./hls.mjs";
import { t } from "./i18n.mjs";
import { downloadFilename, isSecureMediaUrl } from "./media.mjs";

const activeFiles = new Map();
const controllers = new Map();
const runningJobs = new Set();
const RETRY_DELAYS = [400, 1200];
// Segments are buffered whole so a mid-transfer failure can be retried without
// leaving partial bytes in the file, which caps memory at lookahead x segment size.
// ponytail: fine for the usual few-MB segments; budget by bytes if a playlist ever
// ships one enormous segment.
const SEGMENT_LOOKAHEAD = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retriableStatus = (status) => status === 408 || status === 429 || status >= 500;
const estimateEnd = (startedAt, completed, total) => completed && completed < total
  ? new Date(Date.now() + Math.max(1000, ((Date.now() - startedAt) * (total - completed)) / completed)).toISOString()
  : null;

async function report(jobId, changes) {
  await chrome.runtime.sendMessage({
    changes,
    jobId,
    target: "service-worker",
    type: "hls-progress"
  });
}

async function fetchResource(url, signal) {
  if (!isSecureMediaUrl(url)) throw new Error(t("error_https_only"));

  for (let attempt = 0; ; attempt += 1) {
    const retryDelay = RETRY_DELAYS[attempt];
    let response;

    try {
      response = await fetch(url, { cache: "no-store", credentials: "include", signal });
    } catch (error) {
      if (error.name === "AbortError" || retryDelay == null) throw error;
      await sleep(retryDelay);
      continue;
    }

    if (response.ok) return response;
    if (retryDelay == null || !retriableStatus(response.status)) {
      throw new Error(t("error_http_status", String(response.status)));
    }
    await sleep(retryDelay);
  }
}

// Keeps SEGMENT_LOOKAHEAD fetches in flight while segments are consumed in order.
async function* fetchSegments(urls, signal) {
  const pending = [];
  let next = 0;

  const fill = () => {
    while (pending.length < SEGMENT_LOOKAHEAD && next < urls.length) {
      const segment = fetchResource(urls[next], signal)
        .then(async (response) => new Uint8Array(await response.arrayBuffer()));
      // Marks the rejection handled; it still surfaces when the segment is awaited in order.
      segment.catch(() => {});
      pending.push(segment);
      next += 1;
    }
  };

  fill();
  while (pending.length) {
    const bytes = await pending.shift();
    fill();
    yield bytes;
  }
}

async function getMedia(item, signal) {
  const firstText = await (await fetchResource(item.url, signal)).text();
  const selected = selectHlsVariant(firstText, item.url);
  const playlistText = selected.url === item.url
    ? firstText
    : await (await fetchResource(selected.url, signal)).text();
  return parseHlsMedia(playlistText, selected.url);
}

async function cleanup(jobId) {
  const active = activeFiles.get(jobId);
  if (!active) return;

  URL.revokeObjectURL(active.url);
  activeFiles.delete(jobId);
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(active.tempName).catch(() => {});
}

async function offerDownload(job, handle, tempName, filename) {
  const url = URL.createObjectURL(await handle.getFile());
  activeFiles.set(job.id, { tempName, url });
  await report(job.id, {
    estimatedEndTime: null,
    filename,
    progress: 95,
    state: "saving",
    status: t("status_saving")
  });
  const accepted = await chrome.runtime.sendMessage({
    filename,
    jobId: job.id,
    target: "service-worker",
    type: "download-ready",
    url
  });
  if (!accepted?.ok) throw new Error(accepted?.error || t("error_chrome_save"));
}

async function runHlsJob(job) {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  let writable;
  let tempName;

  try {
    await report(job.id, {
      progress: 0,
      state: "preparing",
      status: t("status_reading_hls")
    });
    const media = await getMedia(job.item, controller.signal);
    // The header replay rule starts scoped to the playlist's host; segments on a
    // different CDN host need it too, and only the playlist says where they live.
    await chrome.runtime.sendMessage({
      hosts: [...new Set([media.initUrl, ...media.segmentUrls]
        .filter(Boolean)
        .map((url) => new URL(url).hostname))],
      jobId: job.id,
      target: "service-worker",
      type: "extend-headers"
    });
    const root = await navigator.storage.getDirectory();
    tempName = `downloadswift-${job.id}.mp4`;
    const handle = await root.getFileHandle(tempName, { create: true });
    writable = await handle.createWritable();

    const transmux = media.extension === "mp4" ? null : createTsTransmuxer(globalThis.muxjs);
    const total = media.segmentUrls.length;
    const startedAt = Date.now();
    let initialized = false;
    let lastProgress = -1;
    let written = 0;

    if (!transmux && media.initUrl) {
      const initSegment = new Uint8Array(
        await (await fetchResource(media.initUrl, controller.signal)).arrayBuffer()
      );
      await writable.write(finalizeMp4Duration(
        initSegment,
        media.durationSeconds,
        globalThis.muxjs
      ));
    }

    for await (const bytes of fetchSegments(media.segmentUrls, controller.signal)) {
      written += 1;
      const progress = Math.round((written / total) * 90);
      // Every report is a message plus a session-storage write plus a popup re-render,
      // so only speak up when the percentage actually moves.
      if (progress !== lastProgress) {
        lastProgress = progress;
        const counts = [String(written), String(total)];
        await report(job.id, {
          estimatedEndTime: estimateEnd(startedAt, written, total),
          progress,
          state: "downloading",
          status: transmux
            ? t("status_converting_segment", counts)
            : t("status_downloading_segment", counts)
        });
      }

      if (!transmux) {
        await writable.write(bytes);
        continue;
      }
      for (const chunk of transmux(bytes)) {
        if (!initialized) {
          await writable.write(finalizeMp4Duration(
            chunk.initSegment,
            media.durationSeconds,
            globalThis.muxjs
          ));
          initialized = true;
        }
        await writable.write(chunk.data);
      }
    }

    await writable.close();
    writable = null;
    const filename = downloadFilename(job.pageTitle, { format: "MP4", name: "video.mp4" });
    await offerDownload(job, handle, tempName, filename);
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    if (tempName && !activeFiles.has(job.id)) {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(tempName).catch(() => {});
    }
    await report(job.id, error.name === "AbortError"
      ? { error: null, estimatedEndTime: null, state: "canceled", status: t("status_canceled") }
      : { error: error.message, estimatedEndTime: null, state: "error", status: error.message });
    await cleanup(job.id);
  } finally {
    controller.abort();
    controllers.delete(job.id);
    runningJobs.delete(job.id);
  }
}

async function runDirectJob(job, filename) {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  let writable;
  let tempName;

  try {
    await report(job.id, {
      progress: 0,
      state: "preparing",
      status: t("status_connecting")
    });
    const response = await fetchResource(job.item.url, controller.signal);
    const contentRangeTotal = response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1];
    const total = Number(contentRangeTotal || response.headers.get("content-length"))
      || job.item.size
      || 0;
    const extension = filename.match(/\.[a-z0-9]{2,5}$/i)?.[0] || ".mp4";
    const root = await navigator.storage.getDirectory();
    tempName = `downloadswift-${job.id}${extension}`;
    const handle = await root.getFileHandle(tempName, { create: true });
    writable = await handle.createWritable();
    const reader = response.body.getReader();
    const startedAt = Date.now();
    let received = 0;
    let lastProgress = -1;
    let nextReportAt = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.byteLength;
      const progress = total ? Math.min(90, Math.floor((received / total) * 90)) : 0;
      if (progress === lastProgress && received < nextReportAt) continue;
      lastProgress = progress;
      nextReportAt = received + (5 * 1024 * 1024);
      await report(job.id, {
        estimatedEndTime: estimateEnd(startedAt, received, total),
        progress,
        state: "downloading",
        status: total
          ? t("status_downloading_percent", String(
            Math.min(100, Math.round((received / total) * 100))
          ))
          : t("status_downloading_mb", (received / (1024 * 1024)).toFixed(1))
      });
    }

    await writable.close();
    writable = null;
    await offerDownload(job, handle, tempName, filename);
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    if (tempName && !activeFiles.has(job.id)) {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(tempName).catch(() => {});
    }
    await report(job.id, error.name === "AbortError"
      ? { error: null, estimatedEndTime: null, state: "canceled", status: t("status_canceled") }
      : { error: error.message, estimatedEndTime: null, state: "error", status: error.message });
    await cleanup(job.id);
  } finally {
    controllers.delete(job.id);
    runningJobs.delete(job.id);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;

  if (message.type === "start-hls") {
    if (!runningJobs.has(message.job.id)) {
      runningJobs.add(message.job.id);
      runHlsJob(message.job);
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "start-direct") {
    if (!runningJobs.has(message.job.id)) {
      runningJobs.add(message.job.id);
      runDirectJob(message.job, message.filename);
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "cleanup") {
    cleanup(message.jobId);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "cancel") {
    controllers.get(message.jobId)?.abort();
    sendResponse({ ok: true });
  }
});
