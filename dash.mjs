import { t } from "./i18n.mjs";

const VIDEO_CODEC = /^(avc[13]|hev1|hvc1|vp0?[89]|av01)/i;
const AUDIO_CODEC = /^(mp4a|opus|ac-3|ec-3|flac)/i;

// $Number$, $Time$, $RepresentationID$, $Bandwidth$, each optionally printf-padded
// as $Number%05d$. $$ is a literal dollar sign.
export function expandTemplate(template, values) {
  return template.replace(/\$\$|\$([A-Za-z]+)(?:%0(\d+)d)?\$/g, (match, name, width) => {
    if (match === "$$") return "$";
    const value = values[name];
    if (value == null) return match;
    return width ? String(value).padStart(Number(width), "0") : String(value);
  });
}

// ISO 8601 durations, which is how an MPD states its length: PT1H2M3.5S.
export function parseIsoDuration(value) {
  const match = /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/
    .exec(String(value ?? "").trim());
  if (!match) return 0;

  const [years, months, days, hours, minutes, seconds] = match.slice(1)
    .map((part) => (part ? Number(part) : 0));
  return ((years * 365 + months * 30 + days) * 24 + hours) * 3600 + minutes * 60 + seconds;
}

function codecKinds(representation) {
  const codecs = (representation.codecs ?? "").split(",").map((codec) => codec.trim());
  return {
    audio: codecs.some((codec) => AUDIO_CODEC.test(codec)),
    video: codecs.some((codec) => VIDEO_CODEC.test(codec))
  };
}

// An adaptation set says what it carries either outright or through its codecs.
export function adaptationKind(set) {
  if (set.contentType === "video" || set.contentType === "audio") return set.contentType;
  if (set.mimeType?.startsWith("audio/")) return "audio";
  const kinds = set.representations.map(codecKinds);
  if (kinds.some((kind) => kind.video)) return "video";
  if (kinds.some((kind) => kind.audio)) return "audio";
  return set.mimeType?.startsWith("video/") ? "video" : "";
}

// True when one adaptation set already carries both streams, which is the only
// shape this can download today: two separate streams would have to be muxed.
export function carriesBothStreams(set) {
  return set.representations.some((representation) => {
    const kinds = codecKinds(representation);
    return kinds.audio && kinds.video;
  });
}

const highestBandwidth = (representations) => [...representations]
  .sort((left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0))[0];

// SegmentTemplate is what encoders emit; SegmentList and a plain BaseURL are the
// older shapes and still turn up on self-hosted manifests.
export function representationSegments(representation, set, durationSeconds) {
  const values = {
    Bandwidth: representation.bandwidth,
    RepresentationID: representation.id
  };
  const template = representation.segmentTemplate ?? set.segmentTemplate;

  if (representation.segmentList?.length) {
    return { initUrl: representation.initUrl ?? null, segmentUrls: representation.segmentList };
  }

  if (!template?.media) {
    // A representation with only a BaseURL is one whole file, which the direct
    // download path already handles.
    if (representation.baseUrl) return { initUrl: null, segmentUrls: [representation.baseUrl] };
    throw new Error(t("error_dash_unsupported"));
  }

  const initUrl = template.initialization
    ? expandTemplate(template.initialization, values)
    : null;
  const timescale = Number(template.timescale) || 1;
  const startNumber = Number(template.startNumber ?? 1);
  const segmentUrls = [];

  if (template.timeline?.length) {
    // SegmentTimeline states each run of segments explicitly, with @r repeating
    // the previous entry, so the count never has to be inferred from duration.
    let time = 0;
    let number = startNumber;
    for (const entry of template.timeline) {
      time = entry.t != null ? Number(entry.t) : time;
      const repeats = Number(entry.r ?? 0);
      for (let index = 0; index <= repeats; index += 1) {
        segmentUrls.push(expandTemplate(template.media, { ...values, Number: number, Time: time }));
        time += Number(entry.d);
        number += 1;
      }
    }
    return { initUrl, segmentUrls };
  }

  const segmentSeconds = Number(template.duration) / timescale;
  if (!(segmentSeconds > 0) || !(durationSeconds > 0)) throw new Error(t("error_dash_unsupported"));
  const count = Math.ceil(durationSeconds / segmentSeconds);
  for (let index = 0; index < count; index += 1) {
    segmentUrls.push(expandTemplate(template.media, { ...values, Number: startNumber + index }));
  }
  return { initUrl, segmentUrls };
}

// The manifest object here is the plain shape readDashXml produces, so every
// decision below stays testable without a DOM.
export function selectDashMedia(manifest) {
  const sets = manifest.adaptationSets ?? [];
  if (!sets.length) throw new Error(t("error_dash_no_streams"));

  const videoSets = sets.filter((set) => adaptationKind(set) === "video");
  const audioSets = sets.filter((set) => adaptationKind(set) === "audio");
  const chosen = videoSets.find(carriesBothStreams) ?? videoSets[0];
  if (!chosen) throw new Error(t("error_dash_no_streams"));

  const representation = highestBandwidth(chosen.representations);
  if (!representation) throw new Error(t("error_dash_no_streams"));

  const { initUrl, segmentUrls } = representationSegments(
    representation,
    chosen,
    manifest.durationSeconds
  );
  if (!segmentUrls.length) throw new Error(t("error_no_segments"));

  const media = {
    // What the chosen streams add up to per second, which is the only basis for
    // a size before any segment has been fetched.
    bitsPerSecond: representation.bandwidth ?? 0,
    durationSeconds: manifest.durationSeconds,
    extension: "mp4",
    initUrl,
    segmentUrls
  };

  // Most DASH keeps audio in its own adaptation set. Both streams are fetched
  // and combined into one movie; only a video set that already carries audio
  // skips this.
  if (audioSets.length && !carriesBothStreams(chosen)) {
    const audio = highestBandwidth(audioSets[0].representations);
    const audioSegments = audio
      && representationSegments(audio, audioSets[0], manifest.durationSeconds);
    if (audioSegments?.initUrl && audioSegments.segmentUrls.length) {
      media.audio = audioSegments;
      media.bitsPerSecond += audio.bandwidth ?? 0;
    }
  }

  return media;
}

const attribute = (element, name) => element.getAttribute(name) ?? undefined;

// Thin on purpose: everything this pulls out is fed to the pure functions above.
function readTemplate(element, resolve) {
  if (!element) return undefined;
  const timeline = [...element.querySelectorAll("SegmentTimeline > S")].map((entry) => ({
    d: attribute(entry, "d"),
    r: attribute(entry, "r"),
    t: attribute(entry, "t")
  }));

  return {
    duration: attribute(element, "duration"),
    initialization: attribute(element, "initialization")
      ? resolve(attribute(element, "initialization"))
      : undefined,
    media: attribute(element, "media") ? resolve(attribute(element, "media")) : undefined,
    startNumber: attribute(element, "startNumber"),
    timeline,
    timescale: attribute(element, "timescale")
  };
}

export function readDashXml(xmlText, baseUrl, DomParser) {
  const document = new DomParser().parseFromString(xmlText, "application/xml");
  if (document.querySelector("parsererror")) throw new Error(t("error_not_dash"));

  const mpd = document.querySelector("MPD");
  if (!mpd) throw new Error(t("error_not_dash"));
  if (attribute(mpd, "type") === "dynamic") throw new Error(t("error_live_dash"));

  const manifestBase = mpd.querySelector("BaseURL")?.textContent?.trim();
  const periodBase = new URL(manifestBase || ".", baseUrl).href;

  const adaptationSets = [...document.querySelectorAll("Period > AdaptationSet")].map((set) => {
    const setBase = set.querySelector(":scope > BaseURL")?.textContent?.trim();
    const base = new URL(setBase || ".", periodBase).href;
    const resolve = (value) => new URL(value, base).href;

    return {
      contentType: attribute(set, "contentType"),
      mimeType: attribute(set, "mimeType"),
      segmentTemplate: readTemplate(set.querySelector(":scope > SegmentTemplate"), resolve),
      representations: [...set.querySelectorAll(":scope > Representation")].map((representation) => {
        const ownBase = representation.querySelector(":scope > BaseURL")?.textContent?.trim();
        const ownResolve = (value) => new URL(value, ownBase ? new URL(ownBase, base).href : base).href;
        const list = [...representation.querySelectorAll("SegmentList > SegmentURL")]
          .map((entry) => ownResolve(attribute(entry, "media")));

        return {
          bandwidth: Number(attribute(representation, "bandwidth")) || 0,
          baseUrl: ownBase ? new URL(ownBase, base).href : undefined,
          codecs: attribute(representation, "codecs") ?? attribute(set, "codecs"),
          id: attribute(representation, "id"),
          initUrl: representation.querySelector("SegmentList > Initialization")
            ? ownResolve(attribute(representation.querySelector("SegmentList > Initialization"), "sourceURL"))
            : undefined,
          segmentList: list,
          segmentTemplate: readTemplate(
            representation.querySelector(":scope > SegmentTemplate"),
            ownResolve
          )
        };
      })
    };
  });

  return {
    adaptationSets,
    durationSeconds: parseIsoDuration(attribute(mpd, "mediaPresentationDuration"))
  };
}

export function parseDashMedia(xmlText, baseUrl, DomParser) {
  return selectDashMedia(readDashXml(xmlText, baseUrl, DomParser));
}
