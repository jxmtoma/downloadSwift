// Local HTTPS media server for manual extension testing.
// HTTPS because the extension ignores plain HTTP by design.
//
//   node scripts/test-server.mjs
//
// Serves real, playable video built from test-fixtures/h264-aac.ts, plus the
// failure modes a real CDN will not produce on demand: a one-shot 503, a hard
// 403, and hotlink protection that rejects a missing Referer.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mediaDir = path.join(root, ".test-media");
const certDir = path.join(root, ".test-certs");
const port = Number(process.env.PORT || 8443);
const origin = `https://localhost:${port}`;
const latencyMs = Number(process.env.LATENCY_MS || 120);
const LONG_SEGMENTS = 200;
const SHORT_SEGMENTS = 3;

const fixture = fs.readFileSync(path.join(root, "test-fixtures", "h264-aac.ts"));
const SEGMENT_SECONDS = 8.933333;

// A signed-CDN-style URL long enough that the old regexFilter rule would have had
// to compile ~1.6kB of escaped pattern.
const signature = `?Expires=1900000000&Signature=${"a1b2c3d4e5".repeat(150)}&Key-Pair-Id=TESTKEYPAIRID`;
const clipPath = "/media/clip.mp4";

let inFlight = 0;
let peakInFlight = 0;
let flakyFired = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toTimeString().slice(0, 8), ...parts);

function ensureCert() {
  const key = path.join(certDir, "key.pem");
  const cert = path.join(certDir, "cert.pem");
  if (fs.existsSync(key) && fs.existsSync(cert)) return { cert, key };

  fs.mkdirSync(certDir, { recursive: true });
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "365",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"
  ], { stdio: "ignore" });
  log("generated a self-signed certificate in .test-certs/");
  return { cert, key };
}

// Real fragmented-MP4 and progressive MP4 built once from the TS fixture, so the
// non-transmux branch and the direct-file path both get genuine media.
function ensureMedia() {
  const fmp4Dir = path.join(mediaDir, "fmp4");
  const clip = path.join(mediaDir, "clip.mp4");
  if (fs.existsSync(path.join(fmp4Dir, "index.m3u8")) && fs.existsSync(clip)) return true;

  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    log("ffmpeg not found - the fmp4 and direct scenarios will be unavailable");
    return false;
  }

  fs.mkdirSync(fmp4Dir, { recursive: true });
  const source = path.join(root, "test-fixtures", "h264-aac.ts");
  // aac_adtstoasc: the fixture carries ADTS AAC, which will not mux into MP4 as-is.
  try {
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-i", source, "-c", "copy", "-bsf:a", "aac_adtstoasc",
      "-f", "hls",
      "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
      "-hls_list_size", "0", "-hls_time", "2", "-hls_playlist_type", "vod",
      path.join(fmp4Dir, "index.m3u8")
    ], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-i", source, "-c", "copy", "-bsf:a", "aac_adtstoasc",
      "-movflags", "+faststart", clip
    ], { stdio: ["ignore", "ignore", "inherit"] });
  } catch {
    log("ffmpeg failed - the fmp4 and direct scenarios will be unavailable");
    return false;
  }
  log("built fMP4 segments and clip.mp4 in .test-media/");
  return true;
}

function tsPlaylist(count) {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:9",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    ...Array.from({ length: count }, (_, index) => (
      `#EXTINF:${SEGMENT_SECONDS.toFixed(6)},\n/seg/ts/${index}.ts`
    )),
    "#EXT-X-ENDLIST"
  ].join("\n");
}

const scenarios = {
  "ts-short": {
    fetches: `/vod/ts-short.m3u8`,
    title: `HLS / MPEG-TS, ${SHORT_SEGMENTS} segments - quick playable check`
  },
  ts: {
    fetches: `/vod/ts.m3u8`,
    title: `HLS / MPEG-TS, ${LONG_SEGMENTS} segments - prefetch and throttling`
  },
  fmp4: {
    fetches: `/vod/fmp4/index.m3u8`,
    title: "HLS / fMP4 with EXT-X-MAP - the non-transmux branch"
  },
  flaky: {
    fetches: `/vod/flaky.m3u8`,
    title: "HLS where segment 40 returns 503 once - retry"
  },
  forbidden: {
    fetches: `/vod/forbidden.m3u8`,
    title: "HLS where segment 5 always returns 403 - must fail fast"
  },
  hotlink: {
    fetches: `/vod/hotlink.m3u8`,
    title: "HLS, hotlink-protected playlist and segments - referer replay"
  },
  direct: {
    title: "Direct MP4, hotlink-protected, very long signed URL",
    video: `${clipPath}${signature}`
  }
};

function watchPage(name) {
  const scenario = scenarios[name];
  if (!scenario) return null;
  const body = scenario.video
    ? `<video controls src="${scenario.video}"></video>`
    : `<pre id="out">requesting ${scenario.fetches}</pre>
       <script>
         fetch(${JSON.stringify(scenario.fetches)})
           .then((response) => response.text())
           .then((text) => {
             document.querySelector("#out").textContent =
               "loaded " + ${JSON.stringify(scenario.fetches)} + "\\n\\n" + text.slice(0, 400);
           })
           .catch((error) => { document.querySelector("#out").textContent = String(error); });
       </script>`;

  return `<!doctype html><meta charset="utf-8"><title>${scenario.title}</title>
    <body style="font:14px system-ui;max-width:60rem;margin:3rem auto;padding:0 1rem">
    <h1>${scenario.title}</h1>
    <p>Open the extension popup. This page is served from a path, so a replayed
    Referer reads <code>${origin}/watch/${name}</code> while the origin fallback
    reads <code>${origin}/</code>.</p>
    ${body}
    <p><a href="/">All scenarios</a></p>`;
}

function indexPage() {
  const rows = Object.entries(scenarios)
    .map(([name, scenario]) => `<li><a href="/watch/${name}">${name}</a> - ${scenario.title}</li>`)
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>DownloadSwift test media</title>
    <body style="font:14px system-ui;max-width:60rem;margin:3rem auto;padding:0 1rem">
    <h1>DownloadSwift test media</h1>
    <p>Open each scenario in its own tab - the detector keeps one entry per stream.</p>
    <ul>${rows}</ul>
    <p><a href="/reset">Re-arm the one-shot 503</a></p>`;
}

function send(response, status, type, body, extraHeaders = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": type,
    ...extraHeaders
  });
  response.end(body);
}

async function serveSegment(request, response, index, playlist) {
  if (playlist === "hotlink" && !request.headers.referer) {
    log(`segment ${index}: 403, no referer. The rule did not reach the segment host.`);
    return send(response, 403, "text/plain", "referer required");
  }
  if (playlist === "forbidden" && index === 5) {
    log(`segment ${index}: 403 (permanent - the job should fail immediately)`);
    return send(response, 403, "text/plain", "forbidden");
  }
  if (playlist === "flaky" && index === 40 && !flakyFired) {
    flakyFired = true;
    log(`segment ${index}: 503 (one-shot - expect exactly one retry)`);
    return send(response, 503, "text/plain", "try again");
  }

  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  await sleep(latencyMs);
  inFlight -= 1;
  send(response, 200, "video/mp2t", fixture);
}

function serveFile(request, response, file, type) {
  if (!fs.existsSync(file)) return send(response, 404, "text/plain", "not built");
  const body = fs.readFileSync(file);
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!range) return send(response, 200, type, body, { "accept-ranges": "bytes" });

  const start = Number(range[1]);
  const end = range[2] ? Number(range[2]) : body.length - 1;
  send(response, 206, type, body.subarray(start, end + 1), {
    "accept-ranges": "bytes",
    "content-range": `bytes ${start}-${end}/${body.length}`
  });
}

const hasMedia = ensureMedia();
const { cert, key } = ensureCert();

https.createServer({
  cert: fs.readFileSync(cert),
  key: fs.readFileSync(key)
}, async (request, response) => {
  const url = new URL(request.url, origin);
  const route = url.pathname;

  if (route === "/") return send(response, 200, "text/html; charset=utf-8", indexPage());
  if (route === "/reset") {
    flakyFired = false;
    peakInFlight = 0;
    log("fault state re-armed");
    return send(response, 200, "text/html; charset=utf-8",
      `<meta http-equiv="refresh" content="1;url=/">re-armed`);
  }

  const watch = route.match(/^\/watch\/([\w-]+)$/);
  if (watch) {
    const page = watchPage(watch[1]);
    return page
      ? send(response, 200, "text/html; charset=utf-8", page)
      : send(response, 404, "text/plain", "no such scenario");
  }

  if (route === "/vod/ts.m3u8") {
    return send(response, 200, "application/vnd.apple.mpegurl", tsPlaylist(LONG_SEGMENTS));
  }
  if (route === "/vod/ts-short.m3u8") {
    return send(response, 200, "application/vnd.apple.mpegurl", tsPlaylist(SHORT_SEGMENTS));
  }
  if (route === "/vod/flaky.m3u8") {
    return send(response, 200, "application/vnd.apple.mpegurl",
      tsPlaylist(LONG_SEGMENTS).replace(/\/seg\/ts\//g, "/seg/flaky/"));
  }
  if (route === "/vod/forbidden.m3u8") {
    return send(response, 200, "application/vnd.apple.mpegurl",
      tsPlaylist(20).replace(/\/seg\/ts\//g, "/seg/forbidden/"));
  }
  if (route === "/vod/hotlink.m3u8") {
    log(`hotlink playlist requested with referer: ${request.headers.referer || "(none)"}`);
    if (!request.headers.referer) {
      log("  -> 403: the stream never replayed the referer the page sent.");
      return send(response, 403, "text/plain", "referer required");
    }
    return send(response, 200, "application/vnd.apple.mpegurl",
      tsPlaylist(SHORT_SEGMENTS).replace(/\/seg\/ts\//g, "/seg/hotlink/"));
  }

  const segment = route.match(/^\/seg\/([\w-]+)\/(\d+)\.ts$/);
  if (segment) return serveSegment(request, response, Number(segment[2]), segment[1]);

  if (route.startsWith("/vod/fmp4/")) {
    const name = path.basename(route);
    const type = name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4";
    return serveFile(request, response, path.join(mediaDir, "fmp4", name), type);
  }

  if (route === clipPath) {
    const referer = request.headers.referer;
    log(`clip.mp4 requested with referer: ${referer || "(none)"}`);
    if (!referer) {
      log("  -> 403: hotlink protection. The header replay rule did not apply.");
      return send(response, 403, "text/plain", "referer required");
    }
    return serveFile(request, response, path.join(mediaDir, "clip.mp4"), "video/mp4");
  }

  send(response, 404, "text/plain", "not found");
}).listen(port, () => {
  log(`serving ${origin}`);
  if (!hasMedia) log("fmp4 and direct scenarios need ffmpeg on PATH");
  console.log(`
Chrome trusts nothing self-signed, so run a throwaway profile:

  open -na "Google Chrome" --args \\
    --user-data-dir=/tmp/downloadswift-test \\
    --ignore-certificate-errors

Then chrome://extensions -> Developer mode -> Load unpacked -> ${root}
Open ${origin}/ and enable detection in the popup.

  1  retry          /watch/flaky     one 503 on segment 40; download completes,
                                     this window logs exactly one retry
     fail fast      /watch/forbidden segment 5 is a hard 403; the job must stop
                                     within a second, not after backoff
  2  prefetch       /watch/ts        this window prints peak concurrency on exit
                                     (expect 4, not 1)
  3  throttling     /watch/ts        popup updates smoothly; ~91 updates for
                                     ${LONG_SEGMENTS} segments, not ${LONG_SEGMENTS}
  4  long URL       /watch/direct    ~1.6kB signed URL; downloads without a
                                     declarativeNetRequest rule error
  5  referer        /watch/direct    logs "${origin}/watch/direct".
                                     Now wait ~30s for the service worker to go
                                     idle in chrome://extensions, then download
                                     again: it should log "${origin}/" and still
                                     succeed. Before the fix it logged "(none)"
                                     and 403'd.
  6  stream referer /watch/hotlink   playlist and segments both demand a referer;
                                     this window logs "${origin}/watch/hotlink"
                                     for each. Before the fix both logged
                                     "(none)" and the job failed with an HTTP 403
     playable       /watch/ts-short  open the saved file - 26.8s, seekable
     fmp4 branch    /watch/fmp4      the non-transmux path, also playable
`);
});

process.on("SIGINT", () => {
  log(`peak concurrent segment fetches: ${peakInFlight}`);
  process.exit(0);
});
