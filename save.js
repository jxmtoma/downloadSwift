import { localizeDocument, t } from "./i18n.mjs";

// Safari's save happens here, in an ordinary tab, because a tab is the only
// context that outlives the save. The popover is destroyed the moment focus
// leaves it, and Safari unloads the background page within a couple of minutes;
// a blob URL dies with the document that made it. Handing the popup a URL the
// background page owned is what left a played-for-two-minutes-then-frozen tab
// and a zero-byte "unknown.mp4". This document reads the file and makes its own
// blob, so the bytes stay reachable for as long as the tab is open.
const api = globalThis.browser ?? globalThis.chrome;

localizeDocument();

const statusElement = document.getElementById("status");
const preview = document.getElementById("preview");
const link = document.getElementById("save");

function fail(message) {
  statusElement.textContent = message;
}

(async () => {
  const jobId = new URL(location.href).searchParams.get("job");
  const key = `download-job:${jobId}`;
  const stored = await api.storage.session.get(key);
  const job = stored[key];
  if (!job?.tempName) return fail(t("error_empty_output"));

  let file;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(job.tempName);
    file = await handle.getFile();
  } catch {
    return fail(t("error_empty_output"));
  }
  // The same check the writing page makes: a storage backend that accepted every
  // write and kept none still hands back a handle.
  if (!file.size) return fail(t("error_empty_output"));

  // A file read out of storage carries the wrong type, and Safari renders a
  // wrongly-typed blob as an empty player. Re-labelling copies no bytes.
  const url = URL.createObjectURL(file.slice(0, file.size, "video/mp4"));
  preview.src = url;
  preview.hidden = false;
  link.href = url;
  link.download = job.filename || "video.mp4";
  link.hidden = false;

  // Marking it saved is safe now that a job owns its file for as long as the job
  // row exists: Safari reads the blob on its own schedule, and the sweep no
  // longer treats a saved job's file as a leftover.
  link.addEventListener("click", async () => {
    statusElement.textContent = t("status_saved");
    await api.storage.session.set({
      [key]: { ...job, state: "complete", status: t("status_saved") }
    });
  });
})();
