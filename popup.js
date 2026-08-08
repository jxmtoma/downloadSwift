import { downloadFilename } from "./media.mjs";
import { formatTimeUntil, localizeDocument, t } from "./i18n.mjs";
import { createTsTransmuxer } from "./hls.mjs";
import { getMedia } from "./resolve.mjs";
import { makePreview } from "./preview.mjs";

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
const requestedPreviews = new Set();

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

function visibleFilename(item, job) {
  if (job?.filename) return job.filename;
  const pageTitle = job?.pageTitle ?? currentTabTitle;
  if (item.kind === "file") return downloadFilename(pageTitle, item);
  if (item.format === "HLS" || item.format === "DASH") {
    return downloadFilename(pageTitle, { format: "MP4", name: "video.mp4" });
  }
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

async function startDownload(item, pageTitle = currentTabTitle) {
  const jobId = crypto.randomUUID();
  const key = `download-job:${jobId}`;
  const job = {
    createdAt: Date.now(),
    id: jobId,
    item,
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
  if (item.kind === "file") message.filename = downloadFilename(pageTitle, item);

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
const armPreview = (item, hosts) => api.runtime.sendMessage({
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
    fetchJson: async (url) => JSON.parse(new TextDecoder().decode(await readBytes(url))),
    fetchText: async (url) => new TextDecoder().decode(await readBytes(url))
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

    const parts = [];
    if (media.initUrl) parts.push(await readBytes(media.initUrl));
    const segment = await readBytes(media.segmentUrls[0]);
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

async function fetchPreview(item) {
  const armed = await armPreview(item);
  if (!armed?.ok) return;

  try {
    const blob = item.kind === "file"
      ? new Blob([await readBytes(item.url)], { type: item.mime || "video/mp4" })
      : await streamPreviewBlob(item);
    const { dataUrl } = await makePreview(item, {
      createElement: (tag) => document.createElement(tag),
      fetchBytes: async () => blob
    });
    if (dataUrl) await api.storage.session.set({ [`preview:${item.url}`]: dataUrl });
  } finally {
    await disarmPreview(item, armed.ruleId);
  }
}

// One at a time: every preview arms its own redirect rule and pulls two
// megabytes, and firing all of them at once would stall the list it decorates.
let previewQueue = Promise.resolve();
function requestPreviews(items, previews) {
  for (const item of items) {
    if (previews.has(item.url) || requestedPreviews.has(item.url)) continue;
    requestedPreviews.add(item.url);
    previewQueue = previewQueue.then(() => fetchPreview(item).catch(() => {}));
  }
}

function renderItems(items, jobs = [], previews = new Map(), estimates = new Map()) {
  const visibleItems = [...items];
  for (const job of jobs.sort((left, right) => right.createdAt - left.createdAt)) {
    if (job.item && !visibleItems.some((item) => item.url === job.item.url)) {
      visibleItems.push(job.item);
    }
  }

  list.replaceChildren();
  count.textContent = String(visibleItems.length);
  empty.hidden = visibleItems.length > 0;
  const jobsByUrl = new Map();

  for (const job of jobs) {
    const previous = jobsByUrl.get(job.item?.url);
    if (!previous || job.createdAt > previous.createdAt) jobsByUrl.set(job.item?.url, job);
  }

  for (const item of visibleItems) {
    const job = jobsByUrl.get(item.url);
    const jobActive = ACTIVE_JOB_STATES.has(job?.state);
    const row = document.createElement("li");
    row.className = "media-item";

    const format = document.createElement("div");
    format.className = `format-tile ${item.kind}`;
    const preview = previews.get(item.url);
    if (preview) {
      const thumbnail = document.createElement("img");
      thumbnail.alt = "";
      thumbnail.src = preview;
      format.classList.add("has-preview");
      format.append(thumbnail);
    } else {
      format.textContent = item.format;
    }

    const details = document.createElement("div");
    details.className = "media-details";

    const name = document.createElement("div");
    name.className = "media-name";
    name.textContent = visibleFilename(item, job);
    name.title = name.textContent;

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

    const host = document.createElement("div");
    host.className = "media-host";
    host.textContent = hostFromUrl(item.url);
    host.title = item.url;

    const actions = document.createElement("div");
    actions.className = "media-actions";

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
        try {
          await startDownload(item, job?.pageTitle);
          await selectView("downloading");
        } catch (error) {
          setError(error);
          download.disabled = false;
        }
      });
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

    details.append(name, meta, host);
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
  const detectedItems = (stored[storageKey()] ?? [])
    .filter((item) => !completedUrls.has(item.url) && !activeUrls.has(item.url));
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
  renderItems(selectedView === "detected" ? detectedItems : [], jobs, previews, entries("estimate:"));
  if (selectedView === "detected") requestPreviews(detectedItems, previews);

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
