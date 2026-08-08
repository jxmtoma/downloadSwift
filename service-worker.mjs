import { detectMedia, isSecureMediaUrl } from "./media.mjs";
import { detectSite } from "./sites.mjs";
import { t } from "./i18n.mjs";

const api = globalThis.browser ?? globalThis.chrome;
// A service worker has no document; a background page has one. That is the
// actual difference every branch below cares about, and unlike the presence of
// a `browser` namespace it cannot be confused by Chrome, which now defines one
// too — which sent Chrome down the background-page path and into a dynamic
// import that a service worker is not allowed to make.
const usesBackgroundPage = typeof document !== "undefined";
const usesAnchorDownload = Boolean(
  api.runtime.getManifest?.().browser_specific_settings?.safari
) || !api.downloads?.download;
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
const nativeDownloadCompletions = new Map();
// onChanged can fire before downloads.download() resolves, so a terminal change
// that arrives without its mapping waits here until startManagedDownload writes
// one. That write is the last await before the completion waiter is registered,
// which is what keeps a completion from slipping past both.
const pendingDownloadChanges = new Map();

function settleNativeDownload(downloadId) {
  nativeDownloadCompletions.get(downloadId)?.();
  nativeDownloadCompletions.delete(downloadId);
}

const storageKey = (tabId) => `media:${tabId}`;
const jobKey = (jobId) => `download-job:${jobId}`;
const downloadKey = (downloadId) => `managed-download:${downloadId}`;
const previewKey = (url) => `preview:${url}`;

// Enough of a faststart MP4 to hold the moov and a decodable opening frame.
const PREVIEW_BYTES = 2 * 1024 * 1024;
const PREVIEW_RULE_TIMEOUT = 30000;
const previewsInFlight = new Set();
const previewTimers = new Map();

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
    const stored = await api.storage.session.get(key);
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
      api.storage.session.set({ [key]: items }),
      api.action.setBadgeText({ tabId: details.tabId, text: String(items.length) })
    ]);
  });
}

function recordSiteMedia(tabId, url) {
  const site = detectSite(url);
  if (!site || tabId == null || tabId < 0) return;

  enqueue(async () => {
    // Only where the user already granted access, so a recognised URL never
    // becomes a listing the detector itself would not have been allowed to make.
    const allowed = await api.permissions.contains({ origins: [`${new URL(url).origin}/*`] })
      .catch(() => false);
    if (!allowed) return;

    const key = storageKey(tabId);
    const stored = await api.storage.session.get(key);
    const items = stored[key] ?? [];
    if (items.some((item) => item.url === site.item.url)) return;

    items.unshift({ ...site.item, seenAt: Date.now() });
    items.splice(MAX_ITEMS_PER_TAB);
    await Promise.all([
      api.storage.session.set({ [key]: items }),
      api.action.setBadgeText({ tabId, text: String(items.length) })
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
  enqueue(async () => {
    const key = storageKey(tabId);
    const stored = await api.storage.session.get(key);
    // Previews are keyed by URL and only ever made for a listed item, so they go
    // out with the list that referenced them.
    const derived = (stored[key] ?? [])
      .flatMap((item) => [previewKey(item.url), `estimate:${item.url}`]);
    await Promise.all([
      api.storage.session.remove([key, ...derived]),
      api.action.setBadgeText({ tabId, text: "" })
    ]);
  });
}

async function ensureOffscreenDocument() {
  const url = api.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await api.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length) return;

  if (!creatingOffscreen) {
    creatingOffscreen = api.offscreen.createDocument({
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
  const stored = await api.storage.session.get(key);
  if (!stored[key]) return;
  await api.storage.session.set({
    [key]: { ...stored[key], ...changes, updatedAt: Date.now() }
  });
}

// Set by background.mjs on the browsers that run this in a page alongside the
// preparation code. It is a plain reference rather than a dynamic import of
// offscreen.js: a service worker is forbidden from calling import(), so any
// mistake in deciding which context this is became a hard failure of every
// download rather than a wrong branch.
let runInBackgroundPage = null;

export function setBackgroundPageHandler(handler) {
  runInBackgroundPage = handler;
}

async function sendToOffscreen(message) {
  if (runInBackgroundPage) return runInBackgroundPage(message);
  await ensureOffscreenDocument();
  return api.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function setDownloadUi(enabled) {
  if (api.downloads?.setUiOptions) {
    await api.downloads.setUiOptions({ enabled }).catch(() => {});
  }
}

async function restoreDownloadUiIfIdle() {
  if (pendingDownloads) return;
  const stored = await api.storage.session.get(null);
  const active = Object.keys(stored).some((key) => key.startsWith("managed-download:"));
  if (!active) await setDownloadUi(true);
}

// tabIds -1 keeps the rewrite on the extension's own fetches, never page
// requests, but the condition is Chrome-only: Firefox and Safari reject the
// whole rule as an unexpected property, which fails every header replay.
const scopedToExtension = !usesBackgroundPage;

// Anchored urlFilter instead of regexFilter: signed CDN URLs are long enough
// to trip Chrome's per-rule regex memory budget.
const exactUrlCondition = (url) => ({
  isUrlFilterCaseSensitive: true,
  ...scopedToExtension ? { tabIds: [-1] } : {},
  urlFilter: `|${url}|`
});

// A stream's segment URLs are only known once its playlist is parsed, so scope
// the rule by host and widen it when the offscreen document reports the rest.
// requestDomains everywhere: it has been in Safari since 16.4, below the 17.0
// this build requires. regexFilter is not in the compatibility data at all and
// its accepted syntax varies by browser, and a rejected condition takes down
// every stream download rather than degrading.
// ponytail: two jobs on one host share whichever referer the browser picks;
// scope by rule priority if that ever matters.
const hostCondition = (hosts) => ({
  requestDomains: hosts,
  ...scopedToExtension ? { tabIds: [-1] } : {}
});

let ruleQueue = Promise.resolve();
let lastRuleId = 0;

// Serialized on purpose. Two callers reading getSessionRules() at once pick the
// same id, and the second updateSessionRules is rejected outright for reusing
// it, which took out whichever job or preview happened to lose the race.
async function addHeaderReplayRule(condition, headers) {
  if (!headers?.length) return null;

  const claimed = ruleQueue.then(async () => {
    if (!lastRuleId) {
      const rules = await api.declarativeNetRequest.getSessionRules();
      lastRuleId = Math.max(0, ...rules.map((rule) => rule.id));
    }
    lastRuleId += 1;
    return lastRuleId;
  });
  ruleQueue = claimed.catch(() => {});

  const ruleId = await claimed;
  await api.declarativeNetRequest.updateSessionRules({
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
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
}

async function startManagedDownload({ filename, jobId, offscreen = false, tempName, url }) {
  pendingDownloads += 1;
  try {
    if (usesAnchorDownload) {
      // Safari has no downloads API, and its download attribute does not work
      // from a background page: a click here silently does nothing. The save has
      // to happen in the popup, on the user's own click, where there is a real
      // gesture in a rendered document. So the job stops here and waits.
      await updateJob(jobId, {
        estimatedEndTime: null,
        filename,
        progress: 100,
        state: "ready",
        status: t("status_ready_to_save"),
        tempName
      });
      return { ok: true };
    }
    await setDownloadUi(false);
    const downloadId = await api.downloads.download({ filename, saveAs: false, url });
    // Ordered so a completion can never be overwritten by this 95% update: the
    // mapping onChanged needs lands only after the job is already downloading.
    await updateJob(jobId, {
      downloadId,
      estimatedEndTime: null,
      filename,
      progress: 95,
      state: "downloading",
      status: t("status_downloading_to_folder")
    });
    await api.storage.session.set({ [downloadKey(downloadId)]: { jobId, offscreen } });
    const stashed = pendingDownloadChanges.get(downloadId);
    if (stashed) {
      pendingDownloadChanges.delete(downloadId);
      enqueue(() => finishNativeDownload(stashed));
    }
    const accepted = { downloadId, ok: true };
    if (!usesBackgroundPage || !offscreen) return accepted;
    return new Promise((resolve) => {
      nativeDownloadCompletions.set(downloadId, () => resolve(accepted));
    });
  } catch (error) {
    await updateJob(jobId, {
      error: error.message,
      state: "error",
      status: t("status_download_failed")
    });
    if (offscreen) {
      sendToOffscreen({ jobId, type: "cleanup" }).catch(() => {});
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
    // The real message, not a generic one: a rejected rule or a refused
    // manifest is the only clue the popup can offer, and hiding it behind
    // "could not start" leaves nothing to act on.
    await updateJob(job.id, {
      error: error.message,
      ruleId: null,
      state: "error",
      status: error.message || t("error_start_hls")
    });
    return { error: error.message, ok: false };
  }
}

async function extendHeaderReplayRule(jobId, hosts) {
  const key = jobKey(jobId);
  const stored = await api.storage.session.get(key);
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

// Ads and player stubs are served as video/mp4 from the same page as the real
// video, so the surest way to tell them apart is to look at one. The frame is
// decoded in the popup rather than here: a service worker has no DOM, and an
// offscreen document is never rendered, which is exactly the case a <video>
// element is not obliged to decode for. This side only arms the referer replay
// the fetch needs, then takes it back down.
// ponytail: no preview for HLS or DASH; wire it to their first segment if the
// format tile turns out not to be enough there.
async function armPreview(item, hosts) {
  if (!isSecureMediaUrl(item?.url)) return { ok: false };
  const key = previewKey(item.url);
  const stored = await api.storage.session.get(key);
  // A widening pass for a stream's segment hosts arrives while the first rule is
  // still counted as in flight, so only the opening request checks for that.
  if (stored[key] || (!hosts && previewsInFlight.has(item.url))) return { ok: false };

  previewsInFlight.add(item.url);
  try {
    const replayable = (item.requestHeaders ?? []).filter((header) => header.name !== "range");
    // A stream is read whole a segment at a time, so only a direct file gets the
    // opening-slice range.
    const headers = item.kind === "file" && !hosts
      ? [...replayable, { name: "range", value: `bytes=0-${PREVIEW_BYTES - 1}` }]
      : replayable;
    const ruleId = await addHeaderReplayRule(
      hosts?.length
        ? hostCondition(hosts)
        : item.kind === "file" ? exactUrlCondition(item.url) : hostCondition([new URL(item.url).hostname]),
      headers
    );
    // The popup disarms as soon as it has its frame, but it can also be closed
    // mid-fetch, so the rule gets a deadline of its own either way.
    const timer = setTimeout(() => {
      disarmPreview(item.url, ruleId).catch(() => {});
    }, PREVIEW_RULE_TIMEOUT);
    previewTimers.set(item.url, timer);
    return { ok: true, ruleId };
  } catch (error) {
    previewsInFlight.delete(item.url);
    return { error: error.message, ok: false };
  }
}

async function disarmPreview(url, ruleId) {
  clearTimeout(previewTimers.get(url));
  previewTimers.delete(url);
  previewsInFlight.delete(url);
  await removeHeaderReplayRule(ruleId).catch(() => {});
  return { ok: true };
}

async function finishProgressUpdate(jobId, changes) {
  await updateJob(jobId, changes);
  if (!["canceled", "error"].includes(changes.state)) return;

  const key = jobKey(jobId);
  const stored = await api.storage.session.get(key);
  const ruleId = stored[key]?.ruleId;
  await removeHeaderReplayRule(ruleId).catch(() => {});
  if (ruleId != null) await updateJob(jobId, { ruleId: null });
}

async function acceptPreparedDownload(message) {
  const key = jobKey(message.jobId);
  const stored = await api.storage.session.get(key);
  const ruleId = stored[key]?.ruleId;
  await removeHeaderReplayRule(ruleId).catch(() => {});
  if (ruleId != null) await updateJob(message.jobId, { ruleId: null });
  return startManagedDownload({
    filename: message.filename,
    jobId: message.jobId,
    offscreen: true,
    tempName: message.tempName,
    url: message.url
  });
}

async function cancelJob(jobId) {
  const key = jobKey(jobId);
  const stored = await api.storage.session.get(key);
  const job = stored[key];
  if (!job) return;

  await updateJob(jobId, {
    error: null,
    estimatedEndTime: null,
    state: "canceled",
    status: t("status_canceled")
  });
  if (job.downloadId != null && api.downloads) {
    await api.downloads.cancel(job.downloadId).catch(() => {});
  } else {
    await sendToOffscreen({ jobId, type: "cancel" }).catch(() => {});
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
  api.webRequest.onHeadersReceived.removeListener(recordMedia);
  api.webRequest.onBeforeSendHeaders.removeListener(captureRequestContext);
  api.webRequest.onCompleted.removeListener(forgetRequestContext);
  api.webRequest.onErrorOccurred.removeListener(forgetRequestContext);

  api.webRequest.onHeadersReceived.addListener(
    recordMedia,
    MEDIA_REQUEST_FILTER,
    ["responseHeaders"]
  );
  api.webRequest.onBeforeSendHeaders.addListener(
    captureRequestContext,
    MEDIA_REQUEST_FILTER,
    usesBackgroundPage ? ["requestHeaders"] : ["extraHeaders", "requestHeaders"]
  );
  api.webRequest.onCompleted.addListener(forgetRequestContext, MEDIA_REQUEST_FILTER);
  api.webRequest.onErrorOccurred.addListener(forgetRequestContext, MEDIA_REQUEST_FILTER);
}

registerMediaListeners();
api.permissions.onAdded.addListener(registerMediaListeners);
api.permissions.onRemoved.addListener(registerMediaListeners);

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") clearTab(tabId);
  // Some players never put a manifest on the wire, so there is nothing for the
  // request detector to see. Those pages are recognised by URL instead, and the
  // page itself becomes the item.
  if (changeInfo.status === "complete") recordSiteMedia(tabId, tab?.url);
});

api.tabs.onRemoved.addListener((tabId) => {
  // Download jobs intentionally outlive their source tab.
  enqueue(() => api.storage.session.remove(storageKey(tabId)));
});

export async function handleServiceWorkerMessage(message) {
  if (message.type === "start-hls") {
    return startHlsJob(message.job);
  }

  if (message.type === "extend-headers") {
    await extendHeaderReplayRule(message.jobId, message.hosts);
    return { ok: true };
  }

  if (message.type === "start-direct") {
    return startDirectJob(message);
  }

  if (message.type === "hls-progress") {
    await finishProgressUpdate(message.jobId, message.changes);
    return { ok: true };
  }

  if (message.type === "download-ready") {
    return acceptPreparedDownload(message);
  }

  if (message.type === "cancel-download") {
    await cancelJob(message.jobId);
    return { ok: true };
  }

  if (message.type === "prepare-save") {
    const stored = await api.storage.session.get(jobKey(message.jobId));
    const job = stored[jobKey(message.jobId)];
    if (!job?.tempName) return { error: t("error_empty_output"), ok: false };
    return sendToOffscreen({ jobId: message.jobId, tempName: job.tempName, type: "prepare-save" });
  }

  if (message.type === "arm-preview") {
    return armPreview(message.item, message.hosts);
  }

  if (message.type === "disarm-preview") {
    return disarmPreview(message.url, message.ruleId);
  }
  return { error: "Unknown service-worker message", ok: false };
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "service-worker") return;
  handleServiceWorkerMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message, ok: false }));
  return true;
});

async function finishNativeDownload(change) {
  const finished = change.state?.current === "complete";
  const key = downloadKey(change.id);
  const stored = await api.storage.session.get(key);
  const mapping = stored[key];
  const jobId = mapping?.jobId;
  // A blob download can finish before downloads.download() resolves, so the
  // mapping this needs may not be written yet. Replay once it is, rather than
  // dropping the job at 95% with its temporary file still on disk.
  if (!jobId) {
    pendingDownloadChanges.set(change.id, change);
    return;
  }

  try {
    const jobStored = await api.storage.session.get(jobKey(jobId));
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
        const notification = {
          iconUrl: api.runtime.getURL("icons/icon-128.png"),
          message: jobStored[jobKey(jobId)]?.filename || t("notification_ready"),
          title: t("notification_complete"),
          type: "basic"
        };
        if (api.notifications?.onButtonClicked) {
          notification.buttons = [
            { title: t("open_file") },
            { title: t("show_in_folder") }
          ];
          notification.contextMessage = t("status_saved");
        }
        if (api.notifications?.create) {
          await api.notifications.create(
            `${COMPLETE_NOTIFICATION_PREFIX}${change.id}`,
            notification
          ).catch((error) => console.error("DownloadSwift:", error));
        }
      }
    }
    await api.storage.session.remove(key);
    if (mapping.offscreen) {
      await sendToOffscreen({ jobId, type: "cleanup" }).catch(() => {});
    }
    await restoreDownloadUiIfIdle();
  } finally {
    settleNativeDownload(change.id);
  }
}

api.downloads?.onChanged?.addListener((change) => {
  if (!["complete", "interrupted"].includes(change.state?.current)) return;
  enqueue(() => finishNativeDownload(change));
});

function notificationDownloadId(notificationId) {
  if (!notificationId.startsWith(COMPLETE_NOTIFICATION_PREFIX)) return;
  const downloadId = Number(notificationId.slice(COMPLETE_NOTIFICATION_PREFIX.length));
  return Number.isInteger(downloadId) ? downloadId : undefined;
}

api.notifications?.onButtonClicked?.addListener((notificationId, buttonIndex) => {
  const downloadId = notificationDownloadId(notificationId);
  if (downloadId == null) return;
  if (buttonIndex === 0) api.downloads.open(downloadId);
  if (buttonIndex === 1) api.downloads.show(downloadId);
});

api.notifications?.onClicked?.addListener((notificationId) => {
  const downloadId = notificationDownloadId(notificationId);
  if (downloadId != null) api.downloads.open(downloadId);
});

api.runtime.onStartup.addListener(() => {
  restoreDownloadUiIfIdle().catch((error) => console.error("DownloadSwift:", error));
});
api.runtime.onInstalled.addListener(() => {
  restoreDownloadUiIfIdle().catch((error) => console.error("DownloadSwift:", error));
});
