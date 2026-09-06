import { parseDashMedia } from "./dash.mjs";
import { parseHlsMedia, selectHlsVariant } from "./hls.mjs";
import { t } from "./i18n.mjs";
import { resolveSite } from "./sites.mjs";

// Turning an item into concrete stream URLs is needed in two places now: the
// download, and the popup building a preview from a first segment. The fetchers
// are passed in because those two contexts get their bytes differently.
export async function getMedia(item, { domParser = globalThis.DOMParser, fetchJson, fetchText }) {
  if (item.adapter) {
    if (item.audioOnly) throw new Error(t("error_audio_only_unavailable"));
    const resolved = await resolveSite(item, fetchJson);
    return { ...resolved, initUrl: null, segmentUrls: [] };
  }

  const firstText = await fetchText(item.url);
  if (item.format === "DASH") {
    return parseDashMedia(firstText, item.url, domParser, {
      audioOnly: item.audioOnly,
      representationId: item.representationId,
      representationIndex: item.representationIndex
    });
  }

  const selected = selectHlsVariant(firstText, item.url, item.variantUrl, item.variantIndex);

  // Audio-only skips the video playlist entirely: only the rendition a master
  // keeps in its own audio group can be saved on its own.
  if (item.audioOnly) {
    if (!selected.audioUrl) throw new Error(t("error_audio_only_unavailable"));
    const audio = parseHlsMedia(await fetchText(selected.audioUrl), selected.audioUrl);
    if (audio.extension === "ts") throw new Error(t("error_audio_only_unavailable"));
    return { audioOnly: true, bitsPerSecond: selected.bandwidth ?? 0, ...audio };
  }

  const playlistText = selected.url === item.url ? firstText : await fetchText(selected.url);
  const media = parseHlsMedia(playlistText, selected.url);
  if (selected.audioUrl) {
    const audio = parseHlsMedia(await fetchText(selected.audioUrl), selected.audioUrl);
    if (media.extension === "ts" || audio.extension === "ts") {
      throw new Error(t("error_separate_audio"));
    }
    media.audio = audio;
  }
  // A subtitle rendition that cannot be read is skipped: losing subtitles must
  // never lose the video.
  if (selected.subtitleUrl) {
    try {
      const subtitle = parseHlsMedia(await fetchText(selected.subtitleUrl), selected.subtitleUrl);
      if (subtitle.segmentUrls.length) {
        media.subtitle = {
          initUrl: subtitle.initUrl,
          segmentDurations: subtitle.segmentDurations,
          ...subtitle.segmentRanges ? { segmentRanges: subtitle.segmentRanges } : {},
          segmentUrls: subtitle.segmentUrls
        };
      }
    } catch {
      // Left without subtitles on purpose.
    }
  }
  return { bitsPerSecond: selected.bandwidth ?? 0, ...media };
}
