import { t } from "./i18n.mjs";

// Some players never put a manifest URL on the wire at all: the page asks a
// private JSON endpoint and hands the result straight to Media Source. Nothing
// is observable to the request detector, so the page itself is the item and the
// stream URLs are resolved when the download starts.
const BILIBILI_PAGE = /^https:\/\/(?:www\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]+|av\d+)/i;
const BILIBILI_REFERER = "https://www.bilibili.com/";
// fnval 4048 asks for the DASH response rather than the legacy single-file one.
const BILIBILI_PLAYURL = "https://api.bilibili.com/x/player/playurl";
const BILIBILI_PAGELIST = "https://api.bilibili.com/x/player/pagelist";

export function detectSite(rawUrl) {
  const match = BILIBILI_PAGE.exec(rawUrl ?? "");
  if (!match) return null;

  return {
    id: "bilibili",
    item: {
      adapter: "bilibili",
      format: "DASH",
      kind: "playlist",
      mime: "application/dash+xml",
      name: match[1],
      // The media hosts reject any request without it, and the page is never
      // fetched, so this is stated rather than captured.
      requestHeaders: [{ name: "referer", value: BILIBILI_REFERER }],
      url: rawUrl
    }
  };
}

const identifier = (key) => (key.toLowerCase().startsWith("av")
  ? `aid=${key.slice(2)}`
  : `bvid=${key}`);

// A representation is one self-contained fragmented file addressed by byte
// range, so the header comes from SegmentBase and the media is everything past
// the index.
function stream(representation) {
  const initRange = representation?.SegmentBase?.Initialization;
  const indexRange = representation?.SegmentBase?.indexRange;
  if (!representation?.baseUrl) return null;

  const mediaStart = Number(String(indexRange ?? initRange ?? "0-0").split("-")[1] ?? 0) + 1;
  return {
    initRange: initRange ? `bytes=${initRange}` : null,
    mediaRange: `bytes=${mediaStart}-`,
    selfContained: true,
    url: representation.baseUrl
  };
}

const best = (list) => [...list ?? []]
  .sort((left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0))[0];

async function resolveBilibili(item, fetchJson) {
  const key = BILIBILI_PAGE.exec(item.url)?.[1];
  if (!key) throw new Error(t("error_site_unresolved"));

  const pages = await fetchJson(`${BILIBILI_PAGELIST}?${identifier(key)}`);
  const cid = pages?.data?.[0]?.cid;
  if (!cid) throw new Error(t("error_site_unresolved"));

  const play = await fetchJson(
    `${BILIBILI_PLAYURL}?${identifier(key)}&cid=${cid}&fnval=4048&fourk=1`
  );
  const dash = play?.data?.dash;
  // The legacy response shape is a single flat file with no separate audio,
  // which this cannot tell apart from a DRM-restricted refusal.
  if (!dash) throw new Error(t("error_site_unresolved"));

  const video = stream(best(dash.video));
  const audio = stream(best(dash.audio));
  if (!video) throw new Error(t("error_dash_no_streams"));

  return {
    audio,
    bitsPerSecond: (best(dash.video)?.bandwidth ?? 0) + (best(dash.audio)?.bandwidth ?? 0),
    durationSeconds: Number(dash.duration) || Number(play.data.timelength) / 1000 || 0,
    extension: "mp4",
    title: pages.data[0].part || key,
    video
  };
}

// Always a promise, including on the unknown-adapter path: every caller awaits
// this, and a synchronous throw would escape their error handling.
export async function resolveSite(item, fetchJson) {
  if (item.adapter === "bilibili") return resolveBilibili(item, fetchJson);
  throw new Error(t("error_site_unresolved"));
}
