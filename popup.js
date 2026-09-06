import { byPlayability, candidateRank, downloadFilename } from "./media.mjs";
import { formatTimeUntil, localizeDocument, t } from "./i18n.mjs";
import { createTsTransmuxer, parseHlsMedia, parseHlsVariants, rangeHeader, selectHlsVariant } from "./hls.mjs";
import { hasAudioTrack, readDashXml, selectDashVariants } from "./dash.mjs";
import { getMedia } from "./resolve.mjs";
import { resolveSiteVariants } from "./sites.mjs";
import { makePreview, queueForItem, videoDimensions } from "./preview.mjs";

const api = globalThis.browser ?? globalThis.chrome;

localizeDocument();

const ORIGINS = ["https://*/*"];
// Enough of a fragmented track to hold its first decodable frame.
const PREVIEW_BYTES = 2 * 1024 * 1024;
// "ready" means the file is built and waiting on the user to save it, which is
// how Safari works: it is not finished, so it belongs with the active jobs.
const ACTIVE_JOB_STATES = new Set(["queued", "preparing", "downloading", "saving", "ready"]);
const count = document.querySelector("#count");
const status = document.querySelector("#status");
const detectionBadge = document.querySelector("#detection-badge");
const detectionLabel = document.querySelector("#detection-label");
const enableButton = document.querySelector("#enable");
const disableButton = document.querySelector("#disable");
const clearButton = document.querySelector("#clear");
const detectedTab = document.querySelector("#detected-tab");
const downloadingTab = document.querySelector("#downloading-tab");
const downloadedTab = document.querySelector("#downloaded-tab");
const permissionControls = document.querySelector("#permission-controls");
const mediaControls = document.querySelector("#media-controls");
const empty = document.querySelector("#empty");
const emptyTitle = document.querySelector("#empty-title");
const emptyMessage = document.querySelector("#empty-message");
const list = document.querySelector("#media-list");
const viewEyebrow = document.querySelector("#view-eyebrow");
const viewTitle = document.querySelector("#view-title");

let currentTabId;
let currentTabTitle = "";
let currentTabOrigin = "";
let pollTimer;
let selectedView = "detected";
// A page that offers hover-preview clips lists a dozen candidates, and the
// ranking above already puts the real video first. The tail is folded rather
// than dropped: a preview clip is still a real file someone may have meant to
// save. Folding is also what makes it cheap — each shown item pulls two
// megabytes for its thumbnail and probes its variants, and the ones nobody asked
// to see should cost neither.
const COLLAPSED_ITEMS = 3;
let showAllItems = false;
const shownItems = (items) => (showAllItems ? items : items.slice(0, COLLAPSED_ITEMS));
const requestedPreviews = new Set();
const requestedEstimates = new Set();
const qualityCache = new Map();
const qualityRequests = new Map();
const qualitySelections = new Map();
const filenameEdits = new Map();
const audioOnlySelections = new Map();
const resourceTextCache = new Map();

const storageKey = () => `media:${currentTabId}`;

// Detection watches requests, and a request is only visible where the extension
// holds permission for the host that serves it. A video page almost always pulls
// its media from a different domain than the page, so a grant covering only the
// page's own origin sees nothing at all. The blanket pattern is what gets asked
// for; Safari answers it with the choice between this site and every site.
const accessOrigins = () => ORIGINS;

// Safari grants host access one site at a time and does not report the blanket
// pattern back as granted when only a site was allowed, so both are checked:
// asking about one alone leaves the popup either permanently off or wrongly on.
const siteOrigins = () => (currentTabOrigin ? [`${currentTabOrigin}/*`] : null);

async function detectionAllowed() {
  if (await api.permissions.contains({ origins: ORIGINS })) return true;
  const site = siteOrigins();
  return site ? api.permissions.contains({ origins: site }) : false;
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unit)).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function setError(error) {
  status.textContent = error?.message || String(error);
  status.hidden = false;
}

function hostFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }
}

function streamFilename(pageTitle, item) {
  const base = downloadFilename(pageTitle, { format: "MP4", name: "video.mp4" });
  return audioOnlySelections.get(item.url)
    ? `${base.replace(/\.[^.]+$/, "")}.m4a`
    : base;
}

function visibleFilename(item, job) {
  if (job?.filename) return job.filename;
  const pageTitle = job?.pageTitle ?? currentTabTitle;
  if (item.kind === "file") return downloadFilename(pageTitle, item);
  if (item.format === "HLS" || item.format === "DASH") return streamFilename(pageTitle, item);
  return item.name;
}

async function copyUrl(item, button) {
  const original = button.textContent;
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(item.url);
    button.textContent = t("copied");
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  } catch (error) {
    setError(error);
  } finally {
    button.disabled = false;
  }
}

async function startDownload(item, pageTitle = currentTabTitle, selection, editedFilename) {
  const jobId = crypto.randomUUID();
  const key = `download-job:${jobId}`;
  let filename = downloadFilename(
    editedFilename?.trim() || pageTitle,
    item.kind === "file" ? item : { format: "MP4", name: "video.mp4" }
  );
  // Audio-only writes the same fragmented track under an audio extension.
  if (selection?.audioOnly && item.kind !== "file") {
    filename = `${filename.replace(/\.[^.]+$/, "")}.m4a`;
  }
  const job = {
    createdAt: Date.now(),
    filename,
    id: jobId,
    item: selection ? { ...item, ...selection } : item,
    pageTitle,
    progress: 0,
    state: "queued",
    status: t("status_starting"),
    tabId: currentTabId
  };
  await api.storage.session.set({
    [key]: job
  });

  const message = {
    job,
    target: "service-worker",
    type: item.kind === "file" ? "start-direct" : "start-hls"
  };
  if (item.kind === "file") message.filename = filename;

  // Not awaited, and no browser detection either. Firefox and Safari answer only
  // once the whole job has finished, Chrome answers immediately, and both write
  // the real reason onto the job when something fails. Reading the reply to find
  // that out meant guessing which browser this is, and guessing wrong turned a
  // real error into "could not start the download" with nothing to act on.
  api.runtime.sendMessage(message).catch(async (error) => {
    // Only reached when the message never arrived at all, which the job itself
    // cannot report because nothing ever picked it up.
    await api.storage.session.set({
      [key]: {
        ...job,
        error: error.message,
        state: "error",
        status: error.message || t("error_start_download")
      }
    });
  });
}

// Safari has no downloads API, and a download attribute clicked from here is
// ignored: the click became a navigation onto a blob the background page owned,
// so the tab played for a couple of minutes and froze the moment Safari unloaded
// that page, and saving from it produced page source or an empty file. The save
// runs in a real tab instead, which outlives this popover and that page and
// reads the file for itself.
async function saveReadyJob(job) {
  await api.tabs.create({
    url: api.runtime.getURL(`save.html?job=${encodeURIComponent(job.id)}`)
  });
}

async function cancelDownload(job) {
  const response = await api.runtime.sendMessage({
    jobId: job.id,
    target: "service-worker",
    type: "cancel-download"
  });
  if (!response?.ok) throw new Error(response?.error || t("error_cancel_download"));
}

// The frame is decoded here rather than in the worker: a service worker has no
// DOM at all, and an offscreen document is never rendered, which is exactly the
// case a <video> element is not obliged to decode for. The popup is a real
// rendered document, and it is open precisely when previews are worth having.
const armPreview = (item, hosts, force = false) => api.runtime.sendMessage({
  force,
  hosts,
  item,
  target: "service-worker",
  type: "arm-preview"
});

const disarmPreview = (item, ruleId) => api.runtime.sendMessage({
  ruleId,
  target: "service-worker",
  type: "disarm-preview",
  url: item.url
}).catch(() => {});

// A self-contained track's media range runs to the end of the file; only the
// opening slice of it is needed for one frame.
const sliceRange = (mediaRange) => {
  const start = Number(/bytes=(\d+)-/.exec(mediaRange)?.[1] ?? 0);
  return `bytes=${start}-${start + PREVIEW_BYTES - 1}`;
};

// A ranged response states the whole resource's length after the slash in
// Content-Range, which is an exact size nobody has to estimate.
const totalFromRange = (response) => (
  Number(/\/\s*(\d+)\s*$/.exec(response.headers.get("content-range") ?? "")?.[1]) || 0
);

const readRange = async (url, headers) => {
  const response = await fetch(url, { cache: "no-store", credentials: "include", headers });
  if (!response.ok) throw new Error(String(response.status));
  return { bytes: new Uint8Array(await response.arrayBuffer()), total: totalFromRange(response) };
};

const readBytes = async (url, headers) => (await readRange(url, headers)).bytes;
const readText = async (url) => {
  if (resourceTextCache.has(url)) return resourceTextCache.get(url);
  const value = new TextDecoder().decode(await readBytes(url));
  resourceTextCache.set(url, value);
  return value;
};
const readJson = async (url) => JSON.parse(await readText(url));

function qualityLabel(variant) {
  const height = variant.height || Number(/x(\d+)/.exec(variant.resolution ?? "")?.[1]);
  const resolution = variant.width && height ? `${variant.width}×${height}` : height ? `${height}p` : "";
  const bandwidth = variant.bandwidth >= 1e6
    ? `${(variant.bandwidth / 1e6).toFixed(1)} Mbps`
    : variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)} kbps` : "";
  return [resolution, bandwidth].filter(Boolean).join(" · ") || t("quality");
}

function addQualityPicker(item, qualities, actions, disabled = false) {
  const picker = document.createElement("select");
  picker.className = "quality-picker";
  picker.disabled = disabled;
  picker.setAttribute("aria-label", t("quality"));
  qualities.forEach((quality, index) => {
    const option = document.createElement("option");
    option.textContent = qualityLabel(quality);
    option.value = String(index);
    picker.append(option);
  });
  picker.value = qualitySelections.get(item.url) ?? "0";
  picker.addEventListener("change", () => qualitySelections.set(item.url, picker.value));
  actions.append(picker);
  return picker;
}

// Audio-only output needs the master to keep audio in its own rendition group
// and that rendition to be fragmented MP4 — the same conditions resolve.mjs
// enforces, evaluated here so the popup can grey the option out up front.
// Anything uncertain (a rendition that cannot be fetched or parsed here) counts
// as available and leaves the download as the final judge.
async function hlsAudioAvailable(item, selection, masterText) {
  const selected = selectHlsVariant(masterText, item.url, selection.variantUrl, selection.variantIndex);
  if (!selected.audioUrl) return false;
  try {
    const armed = await armPreview(item, [new URL(selected.audioUrl).hostname]);
    try {
      const audio = parseHlsMedia(await readText(selected.audioUrl), selected.audioUrl);
      return audio.extension !== "ts" && audio.segmentUrls.length > 0;
    } finally {
      if (armed?.ok) await disarmPreview(item, armed.ruleId);
    }
  } catch {
    return true;
  }
}

async function streamQualities(item) {
  const armed = await armPreview(item, undefined, true);
  if (!armed?.ok) return [];

  try {
    if (item.adapter) {
      return (await resolveSiteVariants(item, readJson))
        .map((variant, index) => ({
          audioAvailable: false,
          bandwidth: Number(variant.bandwidth) || 0,
          height: Number(variant.height) || undefined,
          index,
          selection: {
            representationId: variant.id,
            representationIndex: index
          }
        }))
        .sort((left, right) => right.bandwidth - left.bandwidth);
    }

    const text = await readText(item.url);
    if (item.format === "HLS") {
      const variants = parseHlsVariants(text, item.url)
        .map((variant) => ({
          ...variant,
          selection: { variantIndex: variant.index, variantUrl: variant.url }
        }))
        .sort(byPlayability);
      if (!variants.length) {
        // A bare media playlist is its own track: it keeps audio muxed into its
        // segments and offers no rendition a separate download could pick, so
        // the option is decided here rather than left to fail at download time.
        return [{
          audioAvailable: await hlsAudioAvailable(item, {}, text),
          selection: {}
        }];
      }
      // Audio availability follows the AUDIO group of the chosen variant, and
      // variants can name different groups, so each entry carries its own.
      for (const variant of variants) {
        variant.audioAvailable = await hlsAudioAvailable(item, variant.selection, text);
      }
      return variants;
    }

    const manifest = readDashXml(text, item.url, DOMParser);
    // DASH availability is a manifest property, not a per-representation one.
    const audioAvailable = hasAudioTrack(manifest);
    return selectDashVariants(manifest)
      .map((variant, index) => ({
        ...variant,
        audioAvailable,
        index,
        selection: {
          representationId: variant.id,
          representationIndex: index
        }
      }))
      .sort(byPlayability);
  } finally {
    await disarmPreview(item, armed.ruleId);
  }
}

function loadQualities(item) {
  if (qualityCache.has(item.url)) return Promise.resolve(qualityCache.get(item.url));
  if (qualityRequests.has(item.url)) return qualityRequests.get(item.url);

  const request = queueForItem(item.url, () => streamQualities(item))
    .then((qualities) => {
      qualityCache.set(item.url, qualities);
      return qualities;
    })
    .finally(() => qualityRequests.delete(item.url));
  qualityRequests.set(item.url, request);
  return request;
}

const storeSize = async (item, bytes, exact) => {
  if (!(bytes > 0)) return;
  await api.storage.session.set({ [`estimate:${item.url}`]: { bytes, exact } });
};

// A stream has no single file to sample, so the preview is built from its first
// segment: enough to decode one frame, and the same work the download does on
// its first iteration. The playlist and the segments can sit on different hosts,
// so the replay rule is armed once for each.
async function streamPreviewBlob(item) {
  const media = await getMedia(item, {
    fetchJson: readJson,
    fetchText: readText
  });

  const first = media.video ?? { url: media.segmentUrls[0] };
  const hosts = [...new Set([media.initUrl, first.url, media.video?.url]
    .filter(Boolean)
    .map((url) => new URL(url).hostname))];

  const armed = await armPreview(item, hosts);
  try {
    if (media.video) {
      // A self-contained track: the header plus one fragment is a playable clip.
      // Both responses are ranged, so between them they also state the exact
      // size of each track without a request of their own.
      const [init, body, audioProbe] = await Promise.all([
        readRange(media.video.url, { Range: media.video.initRange }),
        readRange(media.video.url, { Range: sliceRange(media.video.mediaRange) }),
        readRange(media.audio.url, { Range: "bytes=0-0" }).catch(() => ({ total: 0 }))
      ]);
      const exact = init.total + audioProbe.total;
      if (exact > 0) await storeSize(item, exact, true);
      return new Blob([init.bytes, body.bytes], { type: "video/mp4" });
    }

    // Segment lists state no total anywhere, so the only figure available short
    // of fetching every segment is the declared bitrate over the runtime.
    await storeSize(
      item,
      Math.round((media.bitsPerSecond || 0) / 8 * (media.durationSeconds || 0)),
      false
    );

    // Byte-range streams keep every segment inside one resource, so the opening
    // slice is requested through the same ranges the download itself uses. The
    // two reads are independent of each other, and the round trip to a CDN is
    // most of what a small init segment costs.
    const [init, segment] = await Promise.all([
      media.initUrl
        ? readBytes(media.initUrl, media.initRange
          ? { Range: rangeHeader(media.initRange) }
          : undefined)
        : null,
      readBytes(media.segmentUrls[0], media.segmentRanges?.[0]
        ? { Range: rangeHeader(media.segmentRanges[0]) }
        : undefined)
    ]);
    const parts = [];
    if (init) parts.push(init);
    if (media.extension === "mp4") {
      parts.push(segment);
    } else {
      const transmux = createTsTransmuxer(globalThis.muxjs);
      for (const chunk of transmux(segment)) {
        if (!parts.length) parts.push(chunk.initSegment);
        parts.push(chunk.data);
      }
    }
    return new Blob(parts, { type: "video/mp4" });
  } finally {
    if (armed?.ok) await disarmPreview(item, armed.ruleId);
  }
}

// What a segment-list stream will weigh is a property of its manifest — the
// declared bitrate over the runtime — and needs no media at all. It was being
// written halfway through building a thumbnail, so a row's size waited on every
// earlier row's megabytes and frame decode before it could appear. Asked for on
// its own it costs nothing: the quality probe has already left these manifests
// in the text cache, so every size lands together, seconds ahead of the pictures.
async function fetchEstimate(item) {
  const armed = await armPreview(item, undefined, true);
  if (!armed?.ok) return;

  try {
    const media = await getMedia(item, { fetchJson: readJson, fetchText: readText });
    // A byte-range stream states an exact total in the ranged responses the
    // preview pass is already making. Only the derived figure is free here.
    if (media.video) return;
    await storeSize(
      item,
      Math.round((media.bitsPerSecond || 0) / 8 * (media.durationSeconds || 0)),
      false
    );
  } catch {
    // A stream that will not resolve has no size to show. The preview pass
    // behind this one surfaces the failure; this pass stays quiet about it.
  } finally {
    await disarmPreview(item, armed.ruleId);
  }
}

async function fetchPreview(item) {
  let preview = {};
  if (item.kind === "file") {
    const metadataRule = await armPreview(item, [new URL(item.url).hostname], true);
    try {
      if (metadataRule?.ok) {
        preview = await videoDimensions(item.url, (tag) => document.createElement(tag));
        await api.storage.session.set({ [`preview:${item.url}`]: preview });
      }
    } catch {
      // A thumbnail can still decode from the capped byte slice below.
    } finally {
      if (metadataRule?.ok) await disarmPreview(item, metadataRule.ruleId);
    }
  }

  const armed = await armPreview(item, undefined, true);
  if (!armed?.ok) return;

  try {
    const blob = item.kind === "file"
      ? new Blob([await readBytes(item.url)], { type: item.mime || "video/mp4" })
      : await streamPreviewBlob(item);
    preview = {
      ...preview,
      ...await makePreview(item, {
        createElement: (tag) => document.createElement(tag),
        fetchBytes: async () => blob
      })
    };
  } finally {
    await disarmPreview(item, armed.ruleId);
  }

  if (preview?.dataUrl || preview?.height) {
    await api.storage.session.set({ [`preview:${item.url}`]: preview });
  }
}

function requestPreviews(items, previews) {
  for (const item of items) {
    if (previews.get(item.url)?.height || requestedPreviews.has(item.url)) continue;
    requestedPreviews.add(item.url);
    queueForItem(item.url, () => fetchPreview(item)).catch(() => {});
  }
}

// Files state their size in a header the moment they are detected; only a
// stream has to be resolved to find one out.
function requestEstimates(items, estimates) {
  for (const item of items) {
    if (item.kind !== "playlist" || estimates.has(item.url) || requestedEstimates.has(item.url)) {
      continue;
    }
    requestedEstimates.add(item.url);
    queueForItem(item.url, () => fetchEstimate(item)).catch(() => {});
  }
}

function requestQualities(items) {
  for (const item of items) {
    if (item.kind === "file" || qualityCache.has(item.url) || qualityRequests.has(item.url)) continue;
    loadQualities(item).then(() => render()).catch(() => {});
  }
}

function renderItems(items, jobs = [], previews = new Map(), estimates = new Map()) {
  const visibleItems = [...items];
  for (const job of jobs.sort((left, right) => right.createdAt - left.createdAt)) {
    if (job.item && !visibleItems.some((item) => item.url === job.item.url)) {
      visibleItems.push(job.item);
    }
  }

  // Every render rebuilds the list, and a preview landing for any row triggers
  // one — so a filename being typed lost its caret to a thumbnail arriving three
  // rows away. The field is put back where it was afterwards.
  const active = document.activeElement;
  const focusedUrl = list.contains(active) ? active.dataset.url : null;
  const caret = focusedUrl ? [active.selectionStart, active.selectionEnd] : null;
  let refocus = null;

  list.replaceChildren();
  // The count stays honest about everything found, folded or not.
  count.textContent = String(visibleItems.length);
  empty.hidden = visibleItems.length > 0;
  // Only the detected list folds. The download views are a record of what the
  // user themselves started, and nothing there is noise to be tidied away.
  const shown = selectedView === "detected" ? shownItems(visibleItems) : visibleItems;
  const jobsByUrl = new Map();

  for (const job of jobs) {
    const previous = jobsByUrl.get(job.item?.url);
    if (!previous || job.createdAt > previous.createdAt) jobsByUrl.set(job.item?.url, job);
  }

  for (const item of shown) {
    const job = jobsByUrl.get(item.url);
    const jobActive = ACTIVE_JOB_STATES.has(job?.state);
    const row = document.createElement("li");
    row.className = "media-item";

    const format = document.createElement("div");
    format.className = `format-tile ${item.kind}`;
    const preview = previews.get(item.url);
    const previewUrl = typeof preview === "string" ? preview : preview?.dataUrl;
    if (previewUrl) {
      const thumbnail = document.createElement("img");
      thumbnail.alt = "";
      thumbnail.src = previewUrl;
      format.classList.add("has-preview");
      format.append(thumbnail);
    } else {
      format.textContent = item.format;
    }

    const details = document.createElement("div");
    details.className = "media-details";

    const editableName = selectedView === "detected" && !jobActive;
    const name = document.createElement(editableName ? "input" : "div");
    name.className = editableName ? "media-name media-name-input" : "media-name";
    if (editableName) {
      name.type = "text";
      name.value = filenameEdits.get(item.url) ?? visibleFilename(item, job);
      name.setAttribute("aria-label", t("filename"));
      name.dataset.url = item.url;
      if (item.url === focusedUrl) refocus = name;
      name.addEventListener("input", () => filenameEdits.set(item.url, name.value));
    } else {
      name.textContent = visibleFilename(item, job);
      name.title = name.textContent;
    }

    const meta = document.createElement("div");
    meta.className = "media-meta";

    const kind = document.createElement("span");
    kind.className = "meta-chip";
    kind.textContent = selectedView === "downloaded"
      ? t("state_downloaded")
      : selectedView === "downloading"
        ? t("state_downloading")
        : item.kind === "file" ? t("video_file") : t("stream_playlist");
    meta.append(kind);

    if (selectedView === "downloading" && job?.tabId !== currentTabId) {
      const background = document.createElement("span");
      background.className = "meta-chip";
      background.textContent = t("background");
      meta.append(background);
    }

    const estimated = estimates.get(item.url);
    if (item.size || estimated) {
      const size = document.createElement("span");
      // A stream's figure is derived from its bitrate, so it is marked as
      // approximate rather than presented as a byte count anyone measured.
      size.textContent = item.size || estimated?.exact
        ? formatBytes(item.size || estimated.bytes)
        : `~${formatBytes(estimated.bytes)}`;
      meta.append(size);
    }

    // Site adapters resolve to one whole file per track, which cannot be split
    // into audio on its own, so the option only shows for playlist streams.
    // The quality probe records whether a separate audio track actually exists;
    // until it has, the checkbox stays as it is and the download stays judge.
    let audioOnlyOption = null;
    if (selectedView === "detected" && !jobActive && !item.adapter
      && (item.format === "HLS" || item.format === "DASH")) {
      const probed = qualityCache.get(item.url)
        ?.[Number(qualitySelections.get(item.url) ?? 0)];
      const audioUnavailable = probed?.audioAvailable === false;
      if (audioUnavailable && audioOnlySelections.get(item.url)) {
        audioOnlySelections.set(item.url, false);
        if (name.type === "text" && !filenameEdits.has(item.url)) {
          name.value = visibleFilename(item, job);
        }
      }
      audioOnlyOption = document.createElement("label");
      audioOnlyOption.className = audioUnavailable
        ? "audio-only-option unavailable"
        : "audio-only-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(audioOnlySelections.get(item.url));
      checkbox.disabled = audioUnavailable;
      if (audioUnavailable) audioOnlyOption.title = t("error_audio_only_unavailable");
      checkbox.addEventListener("change", () => {
        audioOnlySelections.set(item.url, checkbox.checked);
        // The suggested filename follows the choice, unless it was edited by hand.
        if (name.type === "text" && !filenameEdits.has(item.url)) {
          name.value = visibleFilename(item, job);
        }
      });
      audioOnlyOption.append(checkbox, document.createTextNode(t("audio_only")));
    }

    const host = document.createElement("div");
    host.className = "media-host";
    host.textContent = hostFromUrl(item.url);
    host.title = item.url;

    const actions = document.createElement("div");
    actions.className = "media-actions";

    let qualities = qualityCache.get(item.url);
    if (qualities?.length === 1 && preview?.height
      && !qualities[0].height && !qualities[0].resolution) {
      qualities = [{ ...qualities[0], height: preview.height, width: preview.width }];
    }
    if (!qualities?.length && preview?.height) {
      qualities = [{ height: preview.height, width: preview.width }];
    }
    let qualityPicker;
    if (job?.state === "ready") {
      const save = document.createElement("button");
      save.className = "primary";
      save.type = "button";
      save.textContent = t("save");
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await saveReadyJob(job);
        } catch (error) {
          setError(error);
          save.disabled = false;
        }
      });
      actions.append(save);
    } else if (item.kind === "file" || item.format === "HLS" || item.format === "DASH") {
      const download = document.createElement("button");
      download.className = "primary";
      download.type = "button";
      download.disabled = jobActive;
      download.textContent = jobActive
        ? `${job.progress || 0}%`
        : ["error", "canceled"].includes(job?.state) ? t("retry")
          : job?.state === "complete" ? t("again") : t("download");
      download.addEventListener("click", async () => {
        download.disabled = true;
        if (qualityPicker) qualityPicker.disabled = true;
        try {
          if (item.kind !== "file" && qualities === undefined) {
            qualities = await loadQualities(item);
            if (qualities.length > 1) {
              qualityPicker = addQualityPicker(item, qualities, actions);
              download.disabled = false;
              return;
            }
          }
          await startDownload(
            item,
            job?.pageTitle,
            {
              ...qualities?.[qualityPicker?.selectedIndex ?? 0]?.selection,
              ...audioOnlySelections.get(item.url) ? { audioOnly: true } : {}
            },
            name.value
          );
          await selectView("downloading");
        } catch (error) {
          setError(error);
          download.disabled = false;
          if (qualityPicker) qualityPicker.disabled = false;
        }
      });
      if (qualities?.length) {
        qualityPicker = addQualityPicker(item, qualities, actions, jobActive);
      }
      actions.append(download);
    }

    const copy = document.createElement("button");
    copy.className = item.kind === "file" || item.format === "HLS" || item.format === "DASH"
      ? "copy-button"
      : "primary";
    if (jobActive) copy.classList.add("cancel-button");
    copy.type = "button";
    copy.textContent = jobActive
      ? t("cancel")
      : item.kind === "file" ? t("copy_link") : t("copy_url");
    copy.addEventListener("click", async () => {
      try {
        if (jobActive) {
          copy.disabled = true;
          await cancelDownload(job);
        } else {
          await copyUrl(item, copy);
        }
      } catch (error) {
        setError(error);
        copy.disabled = false;
      }
    });
    actions.append(copy);

    details.append(name, meta);
    if (audioOnlyOption) details.append(audioOnlyOption);
    details.append(host);
    row.append(format, details, actions);

    if (job) {
      const jobStatus = document.createElement("div");
      jobStatus.className = `job-status ${job.state}`;

      const jobLabel = document.createElement("span");
      jobLabel.textContent = [job.status, formatTimeUntil(job.estimatedEndTime)]
        .filter(Boolean)
        .join(" ");

      const jobProgress = document.createElement("span");
      jobProgress.className = "job-progress";
      jobProgress.setAttribute("aria-label", t("download_progress"));
      jobProgress.setAttribute("aria-valuemax", "100");
      jobProgress.setAttribute("aria-valuemin", "0");
      jobProgress.setAttribute("aria-valuenow", String(job.progress || 0));
      jobProgress.setAttribute("role", "progressbar");
      const jobProgressBar = document.createElement("span");
      jobProgressBar.style.width = `${job.progress || 0}%`;
      jobProgress.append(jobProgressBar);

      jobStatus.append(jobLabel, jobProgress);
      row.append(jobStatus);
    }

    list.append(row);
  }

  if (refocus) {
    refocus.focus();
    if (caret?.[0] != null) refocus.setSelectionRange(caret[0], caret[1]);
  }

  if (shown.length < visibleItems.length) {
    const more = document.createElement("li");
    more.className = "show-more";
    const button = document.createElement("button");
    button.className = "text-button";
    button.type = "button";
    button.textContent = t("show_more", [String(visibleItems.length - shown.length)]);
    button.addEventListener("click", () => {
      showAllItems = true;
      render().catch(setError);
    });
    more.append(button);
    list.append(more);
  }
}

async function addNativeProgress(jobs) {
  return Promise.all(jobs.map(async (job) => {
    if (!api.downloads || job.downloadId == null || job.state !== "downloading") return job;
    const [download] = await api.downloads.search({ id: job.downloadId });
    if (!download || download.totalBytes <= 0) return job;

    const start = 95;
    const progress = start + Math.round((download.bytesReceived / download.totalBytes) * (100 - start));
    return {
      ...job,
      estimatedEndTime: download.estimatedEndTime,
      progress,
      status: t("status_downloading_bytes", [
        formatBytes(download.bytesReceived),
        formatBytes(download.totalBytes)
      ])
    };
  }));
}

async function render() {
  const allowed = await detectionAllowed();
  detectionBadge.dataset.active = String(allowed);
  detectionLabel.textContent = allowed ? t("state_active") : t("state_off");
  permissionControls.hidden = allowed;
  mediaControls.hidden = !allowed;
  status.hidden = true;

  if (!allowed) {
    count.textContent = "0";
    return;
  }

  const stored = await api.storage.session.get(null);
  const allJobs = Object.entries(stored)
    .filter(([key]) => key.startsWith("download-job:"))
    .map(([, job]) => job);
  const completedUrls = new Set(allJobs
    .filter((job) => job.state === "complete" && job.tabId === currentTabId)
    .map((job) => job.item?.url));
  const activeUrls = new Set(allJobs
    .filter((job) => ACTIVE_JOB_STATES.has(job.state) && job.tabId === currentTabId)
    .map((job) => job.item?.url));
  // Sorted here rather than at render time so the previews and qualities below
  // are fetched in the order the list shows them: they run one at a time, and
  // the video at the top should not wait behind six preview clips.
  const detectedItems = (stored[storageKey()] ?? [])
    .filter((item) => !completedUrls.has(item.url) && !activeUrls.has(item.url))
    .sort((left, right) => candidateRank(right) - candidateRank(left));
  const visibleJobs = selectedView === "downloaded"
    ? allJobs.filter((job) => job.state === "complete")
    : selectedView === "downloading"
      ? allJobs.filter((job) => ACTIVE_JOB_STATES.has(job.state))
      : allJobs.filter((job) => (
        job.tabId === currentTabId
        && !ACTIVE_JOB_STATES.has(job.state)
        && job.state !== "complete"
      ));
  const jobs = await addNativeProgress(visibleJobs);

  viewEyebrow.textContent = selectedView === "detected"
    ? t("current_tab")
    : t("browser_session");
  viewTitle.textContent = selectedView === "downloaded"
    ? t("downloaded_files")
    : selectedView === "downloading" ? t("active_downloads") : t("detected_media");
  clearButton.hidden = selectedView === "downloading";
  clearButton.textContent = selectedView === "downloaded" ? t("clear_history") : t("clear_all");
  emptyTitle.textContent = selectedView === "downloaded"
    ? t("empty_downloaded_title")
    : selectedView === "downloading" ? t("empty_downloading_title") : t("empty_detected_title");
  emptyMessage.textContent = selectedView === "downloaded"
    ? t("empty_downloaded_message")
    : selectedView === "downloading"
      ? t("empty_downloading_message")
      : t("empty_detected_message");
  list.setAttribute("aria-label", viewTitle.textContent);
  const entries = (prefix) => new Map(Object.entries(stored)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value]));
  const previews = entries("preview:");
  const estimates = entries("estimate:");
  renderItems(selectedView === "detected" ? detectedItems : [], jobs, previews, estimates);
  if (selectedView === "detected") {
    // Folded items are left alone: a thumbnail costs two megabytes and a
    // redirect rule, and a quality probe costs a request, for a row nobody is
    // looking at. Expanding the list is what pays for them.
    //
    // Variants for every row first, thumbnails after. Both share one serial
    // queue, and a thumbnail pulls two megabytes and decodes a frame where a
    // variant list is a few kilobytes of text. Asking for them a row at a time
    // put each row's Download button behind the previous row's two megabytes,
    // so the list took as long to become usable as it took to become pretty.
    const shown = shownItems(detectedItems);
    requestQualities(shown);
    requestEstimates(shown, estimates);
    requestPreviews(shown, previews);
  }

  clearTimeout(pollTimer);
  if (jobs.some((job) => job.downloadId != null && job.state === "downloading")) {
    pollTimer = setTimeout(() => render().catch(setError), 750);
  }
}

async function selectView(view) {
  selectedView = view;
  detectedTab.setAttribute("aria-selected", String(view === "detected"));
  downloadingTab.setAttribute("aria-selected", String(view === "downloading"));
  downloadedTab.setAttribute("aria-selected", String(view === "downloaded"));
  await render();
}

detectedTab.addEventListener("click", () => selectView("detected").catch(setError));
downloadingTab.addEventListener("click", () => selectView("downloading").catch(setError));
downloadedTab.addEventListener("click", () => selectView("downloaded").catch(setError));

enableButton.addEventListener("click", async () => {
  enableButton.disabled = true;
  try {
    const allowed = await api.permissions.request({ origins: accessOrigins() });
    if (!allowed) throw new Error(t("error_detection_not_enabled"));
    // The page already made its media requests; only new ones can be observed.
    if (currentTabId != null) await api.tabs.reload(currentTabId);
    await render();
  } catch (error) {
    setError(error);
  } finally {
    enableButton.disabled = false;
  }
});

disableButton.addEventListener("click", async () => {
  disableButton.disabled = true;
  try {
    await api.permissions.remove({ origins: accessOrigins() });
    const site = siteOrigins();
    if (site) await api.permissions.remove({ origins: site }).catch(() => {});
    const stored = await api.storage.session.get(null);
    const mediaKeys = Object.keys(stored).filter((key) => key.startsWith("media:"));
    if (mediaKeys.length) await api.storage.session.remove(mediaKeys);
    const tabs = await api.tabs.query({});
    await Promise.all(tabs.flatMap((tab) => (
      tab.id == null ? [] : api.action.setBadgeText({ tabId: tab.id, text: "" })
    )));
    await render();
  } catch (error) {
    setError(error);
  } finally {
    disableButton.disabled = false;
  }
});

clearButton.addEventListener("click", async () => {
  try {
    const stored = await api.storage.session.get(null);
    const jobKeys = Object.entries(stored)
      .filter(([key, job]) => (
        key.startsWith("download-job:")
        && (selectedView === "downloaded"
          ? job.state === "complete"
          : job.tabId === currentTabId
            && job.state !== "complete"
            && !ACTIVE_JOB_STATES.has(job.state))
      ))
      .map(([key]) => key);
    if (selectedView === "downloaded") {
      if (jobKeys.length) await api.storage.session.remove(jobKeys);
    } else {
      // Previews only exist for listed items, so they go with the list.
      const derivedKeys = (stored[storageKey()] ?? [])
        .flatMap((item) => [`preview:${item.url}`, `estimate:${item.url}`]);
      await Promise.all([
        api.storage.session.remove([storageKey(), ...derivedKeys, ...jobKeys]),
        api.action.setBadgeText({ tabId: currentTabId, text: "" })
      ]);
    }
    await render();
  } catch (error) {
    setError(error);
  }
});

api.storage.onChanged.addListener((changes, area) => {
  if (currentTabId == null || area !== "session") return;
  if (changes[storageKey()] || Object.keys(changes).some((key) => (
    key.startsWith("download-job:") || key.startsWith("preview:") || key.startsWith("estimate:")
  ))) {
    render().catch(setError);
  }
});

(async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) throw new Error(t("error_no_active_tab"));
  currentTabId = tab.id;
  currentTabTitle = tab.title || "";
  try {
    const { origin, protocol } = new URL(tab.url ?? "");
    if (protocol === "https:") currentTabOrigin = origin;
  } catch {
    // A tab with no readable URL falls back to the blanket pattern.
  }
  await render();
})().catch(setError);
