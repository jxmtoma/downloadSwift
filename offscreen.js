import { createTsTransmuxer, parseHlsMedia, selectHlsVariant } from "./hls.mjs";
import {
  boxes,
  combineInitSegments,
  createBoxSplitter,
  createProgressiveMp4,
  fragmentStartTime,
  readTimescale,
  renumberFragment
} from "./mp4.mjs";
import { getMedia } from "./resolve.mjs";
import { t } from "./i18n.mjs";
import { downloadFilename, isSecureMediaUrl } from "./media.mjs";

const api = globalThis.browser ?? globalThis.chrome;
const activeFiles = new Map();
const controllers = new Map();
const runningJobs = new Set();
const liveTempNames = new Set();
const TEMP_PREFIX = "downloadswift-";
let sendToServiceWorker = (message) => api.runtime.sendMessage(message);
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
  await sendToServiceWorker({
    changes,
    jobId,
    target: "service-worker",
    type: "hls-progress"
  });
}

async function fetchResource(url, signal, headers) {
  if (!isSecureMediaUrl(url)) throw new Error(t("error_https_only"));

  for (let attempt = 0; ; attempt += 1) {
    const retryDelay = RETRY_DELAYS[attempt];
    let response;

    try {
      response = await fetch(url, { cache: "no-store", credentials: "include", headers, signal });
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

const readBytes = async (url, signal, headers) => new Uint8Array(
  await (await fetchResource(url, signal, headers)).arrayBuffer()
);

// One whole fragmented file per track, streamed rather than buffered: these run
// to hundreds of megabytes and two of them in memory at once would not survive a
// feature-length video. Header boxes are dropped because the merged header
// written earlier replaces them; only moof and its mdat go through.
async function* trackFragments(track, signal, onBytes) {
  const response = await fetchResource(track.url, signal, { Range: track.mediaRange });
  const reader = response.body.getReader();
  const split = createBoxSplitter();
  let moof = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await onBytes(value.byteLength);
    for (const item of split(value)) {
      if (item.type === "moof") {
        moof = item.bytes;
      } else if (item.type === "mdat" && moof) {
        yield { mdat: item.bytes, moof, time: fragmentStartTime(moof) };
        moof = null;
      }
    }
  }
}

// Written in playback order rather than one whole track after the other. A
// player walking the fragments in file order otherwise sees the video timeline
// and then the audio timeline laid end to end, and reports a file twice as long
// as the video actually is.
async function writeInterleaved(output, tracks, mux, signal, onBytes) {
  const readers = tracks.map((track) => ({
    ...track,
    iterator: trackFragments(track.stream, signal, onBytes)
  }));
  await Promise.all(readers.map(async (reader) => {
    reader.next = await reader.iterator.next();
  }));

  while (readers.some((reader) => !reader.next.done)) {
    const behind = readers
      .filter((reader) => !reader.next.done)
      .sort((left, right) => (
        left.next.value.time / left.timescale - right.next.value.time / right.timescale
      ))[0];

    mux.sequence += 1;
    await output.addFragment(
      renumberFragment(behind.next.value.moof, behind.trackId, mux.sequence),
      behind.next.value.mdat
    );
    behind.next = await behind.iterator.next();
  }
}


// Everything is written as a progressive file rather than a fragmented one.
// macOS does not read fragmented MP4 from disk at all — CoreAudio reports zero
// packets and zero duration — so those downloads played broken in every browser
// on the platform while Windows played them correctly.
// The header can only be written once the media length is known, which means
// either seeking back to the start or staging the media elsewhere first. Not
// every browser implements the positioned write, and one that ignores it leaves
// the header where the media should be, so the capability is measured rather
// than assumed.
async function supportsPositionedWrite(root) {
  const name = `${TEMP_PREFIX}probe`;
  try {
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array([1, 2, 3, 4]));
    await writable.write({ data: new Uint8Array([9]), position: 0, type: "write" });
    await writable.close();
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    return bytes.length === 4 && bytes[0] === 9;
  } catch {
    return false;
  } finally {
    await root.removeEntry(name).catch(() => {});
  }
}

async function createProgressiveOutput(writable, initSegment, staging) {
  const builder = createProgressiveMp4(initSegment);
  const media = staging ? staging.writable : writable;
  // Without staging the header's room is reserved now and filled in at the end.
  if (!staging) await writable.write(new Uint8Array(builder.prefixSize));
  let at = builder.prefixSize;

  const addFragment = async (moof, mdat) => {
    const bytes = builder.addFragment(moof, mdat);
    await media.write(bytes);
    at += bytes.length;
  };

  return {
    addFragment,
    // A segment can hold several moof/mdat pairs, and styp or sidx boxes that
    // describe nothing a progressive file needs.
    async addSegment(bytes) {
      let moof = null;
      for (const found of boxes(bytes)) {
        if (found.type === "moof") moof = bytes.subarray(found.at, found.end);
        else if (found.type === "mdat" && moof) {
          await addFragment(moof, bytes.subarray(found.at, found.end));
          moof = null;
        }
      }
    },
    async finish() {
      if (!staging) {
        await writable.write({ data: builder.header(), position: 0, type: "write" });
        await writable.write({ data: builder.moov(), position: at, type: "write" });
        return;
      }

      // Nothing is written out of order here: the media was staged in a second
      // file, so the finished one is header, then media, then tables, straight
      // through. It costs one extra pass over the bytes.
      await staging.writable.close();
      await writable.write(builder.header());
      const reader = (await staging.handle.getFile()).stream().getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
      }
      await writable.write(builder.moov());
    }
  };
}

async function cleanup(jobId) {
  const active = activeFiles.get(jobId);
  if (!active) return;

  URL.revokeObjectURL(active.url);
  activeFiles.delete(jobId);
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(active.tempName).catch(() => {});
  liveTempNames.delete(active.tempName);
}

// A job normally removes its own temporary file, but a worker restart mid-job,
// or Safari's handoff (which has no completion event to clean up on), can leave
// one behind. Anything not claimed by a job running in this context is stale.
export async function sweepTempFiles() {
  // A job parked for the user to save it owns its file across restarts, and that
  // is the whole point of parking, so it is not a leftover no matter how long it
  // has been sitting there.
  const stored = await api.storage.session.get(null).catch(() => ({}));
  const parked = new Set(Object.entries(stored)
    .filter(([key, job]) => key.startsWith("download-job:") && job?.state === "ready")
    .map(([, job]) => job.tempName)
    .filter(Boolean));

  const root = await navigator.storage.getDirectory();
  for await (const name of root.keys()) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    if (liveTempNames.has(name) || parked.has(name)) continue;
    await root.removeEntry(name).catch(() => {});
  }
}

// A file read back out of storage carries no MIME type, and a typeless blob URL
// gives the browser nothing to go on: Safari opened it as an unknown resource
// and showed an empty player. slice re-labels it without copying the bytes.
export const asVideoBlob = (file) => file.slice(0, file.size, "video/mp4");

async function offerDownload(job, handle, tempName, filename) {
  const file = await handle.getFile();
  // Read back before handing it on. A storage backend that accepted every write
  // and kept none still returns a handle, and the first sign of it was a saved
  // file of zero bytes. Better to fail here, where the reason can be reported.
  if (!file.size) throw new Error(t("error_empty_output"));
  const url = URL.createObjectURL(asVideoBlob(file));
  activeFiles.set(job.id, { tempName, url });
  await report(job.id, {
    estimatedEndTime: null,
    filename,
    progress: 95,
    state: "saving",
    status: t("status_saving")
  });
  const accepted = await sendToServiceWorker({
    filename,
    jobId: job.id,
    target: "service-worker",
    // Safari saves from the popup rather than here, and a blob URL dies with the
    // background page, so the file itself is named as well as its URL.
    tempName,
    type: "download-ready",
    url
  });
  if (!accepted?.ok) throw new Error(accepted?.error || t("error_chrome_save"));
}

// Safari saves from the popup, but the popup reading the file out of storage
// itself handed back a zero-byte blob, and so a zero-byte save, even though this
// page had already checked that very file was not empty. So the page that wrote
// the file is the one that reads it, and passes over a URL instead.
async function prepareSave(jobId, tempName) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(tempName);
  const file = await handle.getFile();
  if (!file.size) throw new Error(t("error_empty_output"));

  const url = URL.createObjectURL(asVideoBlob(file));
  activeFiles.set(jobId, { tempName, url });
  return { ok: true, size: file.size, url };
}

async function runHlsJob(job) {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  let writable;
  let tempName;
  let staging = null;
  let stagingName;

  try {
    await report(job.id, {
      progress: 0,
      state: "preparing",
      status: t(job.item.format === "DASH" ? "status_reading_dash" : "status_reading_hls")
    });
    const media = await getMedia(job.item, {
      fetchJson: async (url) => (await fetchResource(url, controller.signal)).json(),
      fetchText: async (url) => (await fetchResource(url, controller.signal)).text()
    });
    // The header replay rule starts scoped to the playlist's host; segments on a
    // different CDN host need it too, and only the playlist says where they live.
    await sendToServiceWorker({
      hosts: [...new Set([
        media.initUrl,
        ...media.segmentUrls,
        media.video?.url,
        media.audio?.url,
        media.audio?.initUrl,
        ...media.audio?.segmentUrls ?? []
      ]
        .filter(Boolean)
        .map((url) => new URL(url).hostname))],
      jobId: job.id,
      target: "service-worker",
      type: "extend-headers"
    });
    const root = await navigator.storage.getDirectory();
    tempName = `${TEMP_PREFIX}${job.id}.mp4`;
    liveTempNames.add(tempName);
    const handle = await root.getFileHandle(tempName, { create: true });
    writable = await handle.createWritable();

    // Where the header cannot be filled in afterwards, the media is staged in a
    // second file and the finished one is written straight through.
    if (!await supportsPositionedWrite(root)) {
      stagingName = `${TEMP_PREFIX}${job.id}.part`;
      liveTempNames.add(stagingName);
      const stagingHandle = await root.getFileHandle(stagingName, { create: true });
      staging = { handle: stagingHandle, writable: await stagingHandle.createWritable() };
    }

    const transmux = media.extension === "mp4" ? null : createTsTransmuxer(globalThis.muxjs);
    const total = media.segmentUrls.length;
    const startedAt = Date.now();
    let initialized = false;
    let lastProgress = -1;
    let written = 0;

    // DASH normally keeps audio in its own adaptation set. Both streams are
    // fragmented movies that each call themselves track 1, so they get one
    // shared header declaring two tracks and every fragment is renumbered to
    // match before it is written.
    let mux = null;
    let output = null;
    // A site adapter resolves to one whole fragmented file per track rather than
    // a segment list, so both are streamed straight through instead of being
    // fetched segment by segment.
    if (media.video) {
      const [videoInit, audioInit] = await Promise.all([
        readBytes(media.video.url, controller.signal, { Range: media.video.initRange }),
        readBytes(media.audio.url, controller.signal, { Range: media.audio.initRange })
      ]);
      const combined = combineInitSegments(videoInit, audioInit, media.durationSeconds);
      const tracked = { ...combined, sequence: 0 };
      output = await createProgressiveOutput(writable, combined.initSegment, staging);

      let received = 0;
      let lastPercent = -1;
      const onBytes = async (count) => {
        received += count;
        const percent = Math.min(90, Math.floor((received / (media.totalBytes || received * 4)) * 90));
        if (percent === lastPercent) return;
        lastPercent = percent;
        await report(job.id, {
          estimatedEndTime: null,
          progress: percent,
          state: "downloading",
          status: t("status_downloading_mb", (received / (1024 * 1024)).toFixed(1))
        });
      };

      await writeInterleaved(output, [
        { stream: media.video, timescale: readTimescale(videoInit), trackId: combined.videoTrackId },
        { stream: media.audio, timescale: readTimescale(audioInit), trackId: combined.audioTrackId }
      ], tracked, controller.signal, onBytes);
    } else if (media.audio) {
      const [videoInit, audioInit] = await Promise.all([
        readBytes(media.initUrl, controller.signal),
        readBytes(media.audio.initUrl, controller.signal)
      ]);
      const combined = combineInitSegments(videoInit, audioInit, media.durationSeconds);
      mux = { ...combined, sequence: 0 };
      output = await createProgressiveOutput(writable, combined.initSegment, staging);
    } else if (!transmux && media.initUrl) {
      output = await createProgressiveOutput(
        writable,
        await readBytes(media.initUrl, controller.signal),
        staging
      );
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

      if (mux) {
        mux.sequence += 1;
        await output.addSegment(renumberFragment(bytes, mux.videoTrackId, mux.sequence));
        const audioUrl = media.audio.segmentUrls[written - 1];
        if (audioUrl) {
          mux.sequence += 1;
          await output.addSegment(renumberFragment(
            await readBytes(audioUrl, controller.signal),
            mux.audioTrackId,
            mux.sequence
          ));
        }
        continue;
      }

      if (!transmux) {
        // A stream with no initialisation segment states no tracks anywhere, so
        // there is nothing to build sample tables against. Passing it through is
        // what this did before, and is still better than refusing it outright.
        if (output) await output.addSegment(bytes);
        else await writable.write(bytes);
        continue;
      }
      for (const chunk of transmux(bytes)) {
        if (!initialized) {
          // mux.js states the tracks in the first init segment it emits; every
          // later one repeats it, so only the first is used.
          output = await createProgressiveOutput(writable, chunk.initSegment, staging);
          initialized = true;
        }
        await output.addSegment(chunk.data);
      }
    }

    if (output) await output.finish();
    await writable.close();
    writable = null;
    if (stagingName) {
      await root.removeEntry(stagingName).catch(() => {});
      liveTempNames.delete(stagingName);
      staging = null;
    }
    const filename = downloadFilename(
      media.title || job.pageTitle,
      { format: "MP4", name: "video.mp4" }
    );
    await offerDownload(job, handle, tempName, filename);
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    if (staging) await staging.writable.abort().catch(() => {});
    const root = await navigator.storage.getDirectory().catch(() => null);
    if (root && stagingName) {
      await root.removeEntry(stagingName).catch(() => {});
      liveTempNames.delete(stagingName);
    }
    if (root && tempName && !activeFiles.has(job.id)) {
      await root.removeEntry(tempName).catch(() => {});
      liveTempNames.delete(tempName);
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
    tempName = `${TEMP_PREFIX}${job.id}${extension}`;
    liveTempNames.add(tempName);
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
      liveTempNames.delete(tempName);
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

export function setServiceWorkerMessageHandler(handler) {
  sendToServiceWorker = handler;
}

export function handleOffscreenMessage(message, waitForCompletion = false) {
  if (message.type === "start-hls") {
    if (!runningJobs.has(message.job.id)) {
      runningJobs.add(message.job.id);
      const completion = runHlsJob(message.job);
      if (waitForCompletion) return completion.then(() => ({ ok: true }));
    }
    return { ok: true };
  }

  if (message.type === "start-direct") {
    if (!runningJobs.has(message.job.id)) {
      runningJobs.add(message.job.id);
      const completion = runDirectJob(message.job, message.filename);
      if (waitForCompletion) return completion.then(() => ({ ok: true }));
    }
    return { ok: true };
  }

  if (message.type === "cleanup") {
    const completion = cleanup(message.jobId);
    if (waitForCompletion) return completion.then(() => ({ ok: true }));
    return { ok: true };
  }

  if (message.type === "cancel") {
    controllers.get(message.jobId)?.abort();
    return { ok: true };
  }

  if (message.type === "prepare-save") {
    return prepareSave(message.jobId, message.tempName);
  }

  return { error: "Unknown offscreen message", ok: false };
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;
  const result = handleOffscreenMessage(message);
  // Most handlers answer synchronously; a preview has to be awaited.
  if (!(result instanceof Promise)) {
    sendResponse(result);
    return;
  }
  result.then(sendResponse);
  return true;
});

sweepTempFiles().catch((error) => console.error("DownloadSwift:", error));
