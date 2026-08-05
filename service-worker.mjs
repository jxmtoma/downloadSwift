import { detectMedia, isSecureMediaUrl } from "./media.mjs";
import { t } from "./i18n.mjs";

const MAX_ITEMS_PER_TAB = 50;
const OFFSCREEN_PATH = "offscreen.html";
const COMPLETE_NOTIFICATION_PREFIX = "download-complete:";
const MEDIA_REQUEST_FILTER = {
  types: ["media", "other", "xmlhttprequest"],
  urls: ["https://*/*"]
};
let storageQueue = Promise.resolve();
let creatingOffscreen;
let pendingDownloads = 0;
const requestContexts = new Map();

const storageKey = (tabId) => `media:${tabId}`;
const jobKey = (jobId) => `download-job:${jobId}`;
const downloadKey = (downloadId) => `managed-download:${downloadId}`;

function enqueue(task) {
  storageQueue = storageQueue.then(task).catch((error) => {
    console.error("DownloadSwift:", error);
  });
}

function isMasterHls(item) {
  return /(?:^|[._-])master(?:[._-]|$)/i.test(item.name);
}

function playlistDirectory(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname.replace(/[^/]*$/, "")}`;
}

// A service-worker restart between onBeforeSendHeaders and onHeadersReceived drops
// the in-flight context, and Chrome does not replay it. Fall back to what the item
// already carries, then to the page origin, which is what hotlink checks look at.
function replayHeaders(captured, previous, initiator) {
  const headers = captured?.length ? captured : previous?.requestHeaders ?? [];
  if (headers.some((header) => header.name === "referer")) return headers;
  if (!initiator?.startsWith("https://")) return headers;
  return [...headers, { name: "referer", value: `${initiator}/` }];
}

function recordMedia(details) {
  if (details.tabId < 0) return;

  const requestContext = requestContexts.get(details.requestId);
  requestContexts.delete(details.requestId);
  if (details.statusCode >= 300 && details.statusCode < 400) return;
  const media = detectMedia(details);
  if (!media) return;

  enqueue(async () => {
    const key = storageKey(details.tabId);
    const stored = await chrome.storage.session.get(key);
    const items = stored[key] ?? [];

    // A stream's segments sit under its playlist's directory and a player pulls
    // them with fetch, never as a <video> load. That is the only thing separating
    // seg0.mp4 from a real file, since both are just video/mp4 over XHR. What the
    // page actually plays is kept however it is named.
    if (media.kind === "file" && details.type !== "media") {
      const directory = playlistDirectory(details.url);
      const belongsToStream = items.some((item) => (
        item.kind === "playlist" && directory.startsWith(playlistDirectory(item.url))
      ));
      if (belongsToStream) return;
    }

    if (media.format === "HLS") {
      // A stream's variants sit in its master's directory or below it, so two
      // playlists are the same video only when their directories nest. Collapsing
      // every HLS in the tab instead hid all but one player on pages that embed
      // several videos.
      const directory = playlistDirectory(details.url);
      const related = items.filter((item) => {
        if (item.format !== "HLS" || item.url === details.url) return false;
        const other = playlistDirectory(item.url);
        return directory.startsWith(other) || other.startsWith(directory);
      });
      const covered = related.some((item) => (
        playlistDirectory(item.url).length < directory.length || isMasterHls(item)
      ));
      if (covered && !isMasterHls(media)) return;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (!related.includes(item) || isMasterHls(item)) continue;
        if (playlistDirectory(item.url).length >= directory.length) items.splice(index, 1);
      }
    }
    const duplicate = items.findIndex((item) => item.url === details.url);
    const previous = duplicate >= 0 ? items.splice(duplicate, 1)[0] : null;
    items.unshift({
      ...media,
      requestHeaders: replayHeaders(requestContext?.headers, previous, details.initiator),
      seenAt: Date.now(),
      url: details.url
    });
    items.splice(MAX_ITEMS_PER_TAB);

    await Promise.all([
      chrome.storage.session.set({ [key]: items }),
      chrome.action.setBadgeText({ tabId: details.tabId, text: String(items.length) })
    ]);
  });
}

function captureRequestContext(details) {
  if (details.tabId < 0) return;
  const replayable = new Set(["accept", "origin", "range", "referer"]);
  const headers = [];

  for (const header of details.requestHeaders ?? []) {
    const name = header.name.toLowerCase();
    if (!replayable.has(name) || !header.value || headers.some((item) => item.name === name)) continue;
    headers.push({ name, value: name === "range" ? "bytes=0-" : header.value });
  }
  requestContexts.set(details.requestId, { headers });
}

function forgetRequestContext(details) {
  requestContexts.delete(details.requestId);
}

function clearTab(tabId) {
  enqueue(() => Promise.all([
    chrome.storage.session.remove(storageKey(tabId)),
    chrome.action.setBadgeText({ tabId, text: "" })
  ]));
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      justification: t("offscreen_justification"),
      reasons: ["BLOBS"],
      url: OFFSCREEN_PATH
    }).finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
}

async function updateJob(jobId, changes) {
  const key = jobKey(jobId);
  const stored = await chrome.storage.session.get(key);
  if (!stored[key]) return;
  await chrome.storage.session.set({
    [key]: { ...stored[key], ...changes, updatedAt: Date.now() }
  });
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function restoreDownloadUiIfIdle() {
  if (pendingDownloads) return;
  const stored = await chrome.storage.session.get(null);
  const active = Object.keys(stored).some((key) => key.startsWith("managed-download:"));
  if (!active) await chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
}

// Anchored urlFilter instead of regexFilter: signed CDN URLs are long enough
// to trip Chrome's per-rule regex memory budget. tabIds -1 keeps the rewrite
// on the extension's own fetches, never on page-initiated requests.
const exactUrlCondition = (url) => ({
  isUrlFilterCaseSensitive: true,
  tabIds: [-1],
  urlFilter: `|${url}|`
});

// A stream's segment URLs are only known once its playlist is parsed, so scope
// the rule by host and widen it when the offscreen document reports the rest.
// ponytail: two jobs on one host share whichever referer Chrome picks; scope by
// rule priority if that ever matters.
const hostCondition = (hosts) => ({ requestDomains: hosts, tabIds: [-1] });

async function addHeaderReplayRule(condition, headers) {
  if (!headers?.length) return null;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ruleId = Math.max(0, ...rules.map((rule) => rule.id)) + 1;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      action: {
        requestHeaders: headers.map((header) => ({
          header: header.name,
          operation: "set",
          value: header.value
        })),
        type: "modifyHeaders"
      },
      condition,
      id: ruleId,
      priority: 1
    }]
  });
  return ruleId;
}

async function removeHeaderReplayRule(ruleId) {
  if (ruleId == null) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
}

async function startManagedDownload({ filename, jobId, offscreen = false, url }) {
  pendingDownloads += 1;
  try {
    await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
    const downloadId = await chrome.downloads.download({ filename, saveAs: false, url });
    await Promise.all([
      chrome.storage.session.set({ [downloadKey(downloadId)]: { jobId, offscreen } }),
      updateJob(jobId, {
        downloadId,
        estimatedEndTime: null,
        filename,
        progress: 95,
        state: "downloading",
        status: t("status_downloading_to_folder")
      })
    ]);
    return { downloadId, ok: true };
  } catch (error) {
    await updateJob(jobId, {
      error: error.message,
      state: "error",
      status: t("status_download_failed")
    });
    if (offscreen) {
      chrome.runtime.sendMessage({ jobId, target: "offscreen", type: "cleanup" }).catch(() => {});
    }
    return { error: error.message, ok: false };
  } finally {
    pendingDownloads -= 1;
    restoreDownloadUiIfIdle().catch((error) => console.error("DownloadSwift:", error));
  }
}

// Hotlink-protected hosts reject the offscreen document's fetches unless the
// page's referer comes along. Direct downloads have always replayed it; streams
// did not, so their playlist and segment fetches came back as plain 403s.
async function startHlsJob(job) {
  let ruleId;
  try {
    if (!isSecureMediaUrl(job.item.url)) throw new Error(t("error_https_only"));
    ruleId = await addHeaderReplayRule(
      hostCondition([new URL(job.item.url).hostname]),
      job.item.requestHeaders
    );
    await updateJob(job.id, { ruleId });
    await sendToOffscreen({ job, type: "start-hls" });
    return { ok: true };
  } catch (error) {
    await removeHeaderReplayRule(ruleId).catch(() => {});
    await updateJob(job.id, {
      error: error.message,
      ruleId: null,
      state: "error",
      status: t("error_start_hls")
    });
    return { error: error.message, ok: false };
  }
}

async function extendHeaderReplayRule(jobId, hosts) {
  const key = jobKey(jobId);
  const stored = await chrome.storage.session.get(key);
  const job = stored[key];
  if (!job || job.ruleId == null) return;

  const domains = new Set([new URL(job.item.url).hostname, ...hosts]);
  if (domains.size === 1) return;
  // Added before the old rule goes away so no fetch slips through unlabelled.
  const ruleId = await addHeaderReplayRule(
    hostCondition([...domains]),
    job.item.requestHeaders
  );
  await removeHeaderReplayRule(job.ruleId);
  await updateJob(jobId, { ruleId });
}

async function startDirectJob({ filename, job }) {
  let ruleId;
  try {
    if (!isSecureMediaUrl(job.item.url)) throw new Error(t("error_https_only"));
    const headers = [...(job.item.requestHeaders ?? [])];
    if (!headers.some((header) => header.name === "range")) {
      headers.push({ name: "range", value: "bytes=0-" });
    }
    ruleId = await addHeaderReplayRule(exactUrlCondition(job.item.url), headers);
    await updateJob(job.id, {
      progress: 0,
      ruleId,
      state: "preparing",
      status: t("status_preparing_direct")
    });
    await sendToOffscreen({ filename, job, type: "start-direct" });
    return { ok: true };
  } catch (error) {
    await removeHeaderReplayRule(ruleId).catch(() => {});
    await updateJob(job.id, {
      error: error.message,
      ruleId: null,
      state: "error",
      status: error.message
    });
    return { error: error.message, ok: false };
  }
}

async function finishProgressUpdate(jobId, changes) {
  await updateJob(jobId, changes);
  if (!["canceled", "error"].includes(changes.state)) return;

  const key = jobKey(jobId);
  const stored = await chrome.storage.session.get(key);
  const ruleId = stored[key]?.ruleId;
  await removeHeaderReplayRule(ruleId).catch(() => {});
  if (ruleId != null) await updateJob(jobId, { ruleId: null });
}

async function acceptPreparedDownload(message) {
  const key = jobKey(message.jobId);
  const stored = await chrome.storage.session.get(key);
  const ruleId = stored[key]?.ruleId;
  await removeHeaderReplayRule(ruleId).catch(() => {});
  if (ruleId != null) await updateJob(message.jobId, { ruleId: null });
  return startManagedDownload({
    filename: message.filename,
    jobId: message.jobId,
    offscreen: true,
    url: message.url
  });
}

async function cancelJob(jobId) {
  const key = jobKey(jobId);
  const stored = await chrome.storage.session.get(key);
  const job = stored[key];
  if (!job) return;

  await updateJob(jobId, {
    error: null,
    estimatedEndTime: null,
    state: "canceled",
    status: t("status_canceled")
  });
  if (job.downloadId != null) {
    await chrome.downloads.cancel(job.downloadId).catch(() => {});
  } else {
    chrome.runtime.sendMessage({ jobId, target: "offscreen", type: "cancel" }).catch(() => {});
  }
  await removeHeaderReplayRule(job.ruleId).catch(() => {});
  if (job.ruleId != null) await updateJob(jobId, { ruleId: null });
}

// webRequest binds the host permissions the extension held when the listener was
// added, so listeners registered before the user grants access never see those
// hosts, and listeners registered while access was granted would keep seeing them
// after it is revoked. Re-register on both edges; without this, detection only
// starts working once the worker happens to restart.
function registerMediaListeners() {
  chrome.webRequest.onHeadersReceived.removeListener(recordMedia);
  chrome.webRequest.onBeforeSendHeaders.removeListener(captureRequestContext);
  chrome.webRequest.onCompleted.removeListener(forgetRequestContext);
  chrome.webRequest.onErrorOccurred.removeListener(forgetRequestContext);

  chrome.webRequest.onHeadersReceived.addListener(
    recordMedia,
    MEDIA_REQUEST_FILTER,
    ["responseHeaders"]
  );
  chrome.webRequest.onBeforeSendHeaders.addListener(
    captureRequestContext,
    MEDIA_REQUEST_FILTER,
    ["extraHeaders", "requestHeaders"]
  );
  chrome.webRequest.onCompleted.addListener(forgetRequestContext, MEDIA_REQUEST_FILTER);
  chrome.webRequest.onErrorOccurred.addListener(forgetRequestContext, MEDIA_REQUEST_FILTER);
}

registerMediaListeners();
chrome.permissions.onAdded.addListener(registerMediaListeners);
chrome.permissions.onRemoved.addListener(registerMediaListeners);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") clearTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Download jobs intentionally outlive their source tab.
  enqueue(() => chrome.storage.session.remove(storageKey(tabId)));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "service-worker") return;

  if (message.type === "start-hls") {
    startHlsJob(message.job).then(sendResponse);
    return true;
  }

  if (message.type === "extend-headers") {
    extendHeaderReplayRule(message.jobId, message.hosts)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: error.message, ok: false }));
    return true;
  }

  if (message.type === "start-direct") {
    startDirectJob(message).then(sendResponse);
    return true;
  }

  if (message.type === "hls-progress") {
    finishProgressUpdate(message.jobId, message.changes)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: error.message, ok: false }));
    return true;
  }

  if (message.type === "download-ready") {
    acceptPreparedDownload(message).then(sendResponse);
    return true;
  }

  if (message.type === "cancel-download") {
    cancelJob(message.jobId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: error.message, ok: false }));
    return true;
  }
});

chrome.downloads.onChanged.addListener((change) => {
  const finished = change.state?.current === "complete";
  const failed = change.state?.current === "interrupted";
  if (!finished && !failed) return;

  enqueue(async () => {
    const key = downloadKey(change.id);
    const stored = await chrome.storage.session.get(key);
    const mapping = stored[key];
    const jobId = mapping?.jobId;
    if (!jobId) return;

    const jobStored = await chrome.storage.session.get(jobKey(jobId));
    const canceled = jobStored[jobKey(jobId)]?.state === "canceled";
    if (!canceled) {
      await updateJob(jobId, finished
        ? { estimatedEndTime: null, progress: 100, state: "complete", status: t("status_saved") }
        : {
          error: change.error?.current || t("error_chrome_interrupted"),
          estimatedEndTime: null,
          state: "error",
          status: t("status_download_failed_reason", [
            change.error?.current || t("unknown_error")
          ])
        });
      if (finished) {
        await chrome.notifications.create(`${COMPLETE_NOTIFICATION_PREFIX}${change.id}`, {
          buttons: [
            { title: t("open_file") },
            { title: t("show_in_folder") }
          ],
          contextMessage: t("status_saved"),
          iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
          message: jobStored[jobKey(jobId)]?.filename || t("notification_ready"),
          title: t("notification_complete"),
          type: "basic"
        }).catch((error) => console.error("DownloadSwift:", error));
      }
    }
    await chrome.storage.session.remove(key);
    if (mapping.offscreen) {
      chrome.runtime.sendMessage({ jobId, target: "offscreen", type: "cleanup" }).catch(() => {});
    }
    await restoreDownloadUiIfIdle();
  });
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (!notificationId.startsWith(COMPLETE_NOTIFICATION_PREFIX)) return;
  const downloadId = Number(notificationId.slice(COMPLETE_NOTIFICATION_PREFIX.length));
  if (!Number.isInteger(downloadId)) return;
  if (buttonIndex === 0) chrome.downloads.open(downloadId);
  if (buttonIndex === 1) chrome.downloads.show(downloadId);
});

chrome.runtime.onStartup.addListener(() => {
  restoreDownloadUiIfIdle().catch((error) => console.error("DownloadSwift:", error));
});
chrome.runtime.onInstalled.addListener(() => {
  restoreDownloadUiIfIdle().catch((error) => console.error("DownloadSwift:", error));
});
