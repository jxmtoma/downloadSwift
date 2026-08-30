import { parseDashMedia } from "./dash.mjs";
import { parseHlsMedia, selectHlsVariant } from "./hls.mjs";
import { t } from "./i18n.mjs";
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
  if (item.format === "DASH") {
    return parseDashMedia(firstText, item.url, domParser, {
      representationId: item.representationId,
      representationIndex: item.representationIndex
    });
  }

  const selected = selectHlsVariant(firstText, item.url, item.variantUrl, item.variantIndex);
  const playlistText = selected.url === item.url ? firstText : await fetchText(selected.url);
  const media = parseHlsMedia(playlistText, selected.url);
  if (selected.audioUrl) {
    const audio = parseHlsMedia(await fetchText(selected.audioUrl), selected.audioUrl);
    if (media.extension === "ts" || audio.extension === "ts") {
      throw new Error(t("error_separate_audio"));
    }
    media.audio = audio;
  }
  return { bitsPerSecond: selected.bandwidth ?? 0, ...media };
}
