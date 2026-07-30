import { downloadFilename } from "./media.mjs";
import { localizeDocument, t } from "./i18n.mjs";

localizeDocument();

const ORIGINS = ["https://*/*"];
const ACTIVE_JOB_STATES = new Set(["queued", "preparing", "downloading", "saving"]);
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
let pollTimer;
let selectedView = "detected";

const storageKey = () => `media:${currentTabId}`;

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
  if (item.format === "HLS") {
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
  await chrome.storage.session.set({
    [key]: job
  });

  const message = {
    job,
    target: "service-worker",
    type: item.kind === "file" ? "start-direct" : "start-hls"
  };
  if (item.kind === "file") message.filename = downloadFilename(pageTitle, item);

  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    await chrome.storage.session.set({
      [key]: {
        ...job,
        error: response?.error || t("error_start_download"),
        state: "error",
        status: t("error_start_download")
      }
    });
    throw new Error(response?.error || t("error_start_download"));
  }
}

async function cancelDownload(job) {
  const response = await chrome.runtime.sendMessage({
    jobId: job.id,
    target: "service-worker",
    type: "cancel-download"
  });
  if (!response?.ok) throw new Error(response?.error || t("error_cancel_download"));
}

function renderItems(items, jobs = []) {
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
    format.textContent = item.format;

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

    if (item.size) {
      const size = document.createElement("span");
      size.textContent = formatBytes(item.size);
      meta.append(size);
    }

    const host = document.createElement("div");
    host.className = "media-host";
    host.textContent = hostFromUrl(item.url);
    host.title = item.url;

    const actions = document.createElement("div");
    actions.className = "media-actions";

    if (item.kind === "file" || item.format === "HLS") {
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
    copy.className = item.kind === "file" || item.format === "HLS" ? "copy-button" : "primary";
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
      jobLabel.textContent = job.status;

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
    if (job.downloadId == null || job.state !== "downloading") return job;
    const [download] = await chrome.downloads.search({ id: job.downloadId });
    if (!download || download.totalBytes <= 0) return job;

    const start = 95;
    const progress = start + Math.round((download.bytesReceived / download.totalBytes) * (100 - start));
    return {
      ...job,
      progress,
      status: t("status_downloading_bytes", [
        formatBytes(download.bytesReceived),
        formatBytes(download.totalBytes)
      ])
    };
  }));
}

async function render() {
  const allowed = await chrome.permissions.contains({ origins: ORIGINS });
  detectionBadge.dataset.active = String(allowed);
  detectionLabel.textContent = allowed ? t("state_active") : t("state_off");
  permissionControls.hidden = allowed;
  mediaControls.hidden = !allowed;
  status.hidden = true;

  if (!allowed) {
    count.textContent = "0";
    return;
  }

  const stored = await chrome.storage.session.get(null);
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
  renderItems(selectedView === "detected" ? detectedItems : [], jobs);

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
    const allowed = await chrome.permissions.request({ origins: ORIGINS });
    if (!allowed) throw new Error(t("error_detection_not_enabled"));
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
    await chrome.permissions.remove({ origins: ORIGINS });
    const stored = await chrome.storage.session.get(null);
    const mediaKeys = Object.keys(stored).filter((key) => key.startsWith("media:"));
    if (mediaKeys.length) await chrome.storage.session.remove(mediaKeys);
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.flatMap((tab) => (
      tab.id == null ? [] : chrome.action.setBadgeText({ tabId: tab.id, text: "" })
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
    const stored = await chrome.storage.session.get(null);
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
      if (jobKeys.length) await chrome.storage.session.remove(jobKeys);
    } else {
      await Promise.all([
        chrome.storage.session.remove([storageKey(), ...jobKeys]),
        chrome.action.setBadgeText({ tabId: currentTabId, text: "" })
      ]);
    }
    await render();
  } catch (error) {
    setError(error);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (currentTabId == null || area !== "session") return;
  if (changes[storageKey()] || Object.keys(changes).some((key) => key.startsWith("download-job:"))) {
    render().catch(setError);
  }
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) throw new Error(t("error_no_active_tab"));
  currentTabId = tab.id;
  currentTabTitle = tab.title || "";
  await render();
})().catch(setError);
