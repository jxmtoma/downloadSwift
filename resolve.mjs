import { parseDashMedia } from "./dash.mjs";
import { parseHlsMedia, selectHlsVariant } from "./hls.mjs";
import { resolveSite } from "./sites.mjs";

// Turning an item into concrete stream URLs is needed in two places now: the
// download, and the popup building a preview from a first segment. The fetchers
// are passed in because those two contexts get their bytes differently.
export async function getMedia(item, { domParser = globalThis.DOMParser, fetchJson, fetchText }) {
  if (item.adapter) {
    const resolved = await resolveSite(item, fetchJson);
    return { ...resolved, initUrl: null, segmentUrls: [] };
  }

  const firstText = await fetchText(item.url);
  if (item.format === "DASH") return parseDashMedia(firstText, item.url, domParser);

  const selected = selectHlsVariant(firstText, item.url);
  const playlistText = selected.url === item.url ? firstText : await fetchText(selected.url);
  return { bitsPerSecond: selected.bandwidth ?? 0, ...parseHlsMedia(playlistText, selected.url) };
}
