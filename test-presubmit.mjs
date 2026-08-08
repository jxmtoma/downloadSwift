import assert from "node:assert/strict";
import fs from "node:fs";
import { firefoxManifest, safariManifest } from "./scripts/browser-manifest.mjs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const localeDirectories = fs.readdirSync("_locales").sort();
const locales = Object.fromEntries(localeDirectories.map((locale) => [
  locale,
  JSON.parse(fs.readFileSync(`_locales/${locale}/messages.json`, "utf8"))
]));
const englishKeys = Object.keys(locales.en).sort();

assert.deepEqual(localeDirectories, [
  "de",
  "en",
  "es",
  "fr",
  "ja",
  "ko",
  "pt_BR",
  "zh_CN",
  "zh_TW"
]);
assert.equal(manifest.default_locale, "en");
assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
assert.ok(manifest.permissions.includes("downloads.open"));
assert.equal(manifest.icons["64"], "icons/icon-64.png");
assert.ok(fs.existsSync(manifest.icons["64"]));
assert.equal(manifest.update_url, undefined, "Store packages must not pin a browser-specific updater");

const firefox = firefoxManifest(manifest);
assert.deepEqual(firefox.background, { page: "background.html" });
assert.equal(firefox.minimum_chrome_version, undefined);
assert.ok(!firefox.permissions.includes("downloads.ui"));
assert.ok(!firefox.permissions.includes("offscreen"));
assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, "142.0");
assert.deepEqual(
  firefox.browser_specific_settings.gecko.data_collection_permissions.required,
  ["websiteContent"]
);

const safari = safariManifest(manifest);
assert.deepEqual(safari.background, { page: "background.html" });
assert.equal(safari.minimum_chrome_version, undefined);
for (const permission of ["downloads", "downloads.open", "downloads.ui", "notifications", "offscreen"]) {
  assert.ok(!safari.permissions.includes(permission));
}
// createWritable, which every download depends on, landed in Safari 26.
assert.equal(safari.browser_specific_settings.safari.strict_min_version, "26.0");
assert.equal(safari.icons["512"], "icon.svg");

for (const [locale, messages] of Object.entries(locales)) {
  assert.deepEqual(Object.keys(messages).sort(), englishKeys, `${locale} has missing or extra messages`);
  for (const [key, value] of Object.entries(messages)) {
    assert.equal(typeof value.message, "string", `${locale}.${key} needs a message`);
    assert.ok(value.message.trim(), `${locale}.${key} is empty`);
    const named = [...value.message.matchAll(/\$([a-z_]+)\$/gi)].map((match) => match[1]).sort();
    assert.deepEqual(
      Object.keys(value.placeholders ?? {}).sort(),
      named,
      `${locale}.${key} placeholders do not match`
    );
  }
  assert.doesNotMatch(
    `${messages.extension_name.message} ${messages.extension_description.message}`,
    /\bchrome\b/i,
    `${locale} store name and description must work in Chrome and Edge`
  );
}

const sourceFiles = [
  "dash.mjs",
  "hls.mjs",
  "mp4.mjs",
  "offscreen.js",
  "popup.html",
  "popup.js",
  "preview.mjs",
  "resolve.mjs",
  "save.html",
  "save.js",
  "service-worker.mjs",
  "sites.mjs"
];
const source = sourceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
const referencedKeys = new Set([
  ...[...source.matchAll(/\bt\("([a-z0-9_]+)"/g)].map((match) => match[1]),
  ...[...source.matchAll(/data-i18n(?:-aria-label)?="([a-z0-9_]+)"/g)].map((match) => match[1]),
  ...[...JSON.stringify(manifest).matchAll(/__MSG_([a-z0-9_]+)__/g)].map((match) => match[1])
]);
assert.deepEqual(
  [...referencedKeys].filter((key) => !locales.en[key]),
  [],
  "Every referenced localization key must exist in English"
);

// A service worker is forbidden from calling import(), and Chrome throws before
// any download starts. Nothing that can be loaded into one may contain a
// dynamic import, comments aside.
for (const file of sourceFiles.filter((name) => name.endsWith(".mjs") || name.endsWith(".js"))) {
  const code = fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(
    code,
    /(^|[^.\w])import\s*\(/,
    `${file} must not use a dynamic import: a service worker cannot run one`
  );
}

// Detection has to be loaded on its own, before the preparation half. When both
// were one module graph, one failed import stopped media being detected at all.
const backgroundPage = fs.readFileSync("background.html", "utf8");
assert.ok(
  backgroundPage.indexOf("service-worker.mjs") < backgroundPage.indexOf("background.mjs"),
  "background.html must load service-worker.mjs before background.mjs"
);

const disclosure = locales.en.privacy_disclosure.message;
for (const phrase of ["media URLs", "page titles", "download status", "request headers", "cookies", "HTTPS", "developer"]) {
  assert.ok(disclosure.includes(phrase), `Disclosure must mention ${phrase}`);
}

const packageScript = fs.readFileSync("scripts/package.sh", "utf8");
assert.match(packageScript, /\bi18n\.mjs\b/);
assert.match(packageScript, /\b_locales\b/);
assert.match(packageScript, /package_background_browser firefox/);
assert.match(packageScript, /package_background_browser safari/);
// Every package must draw from the same list, so a new module cannot reach one
// browser's build and miss another's.
assert.match(packageScript, /^shared_files=/m);
assert.ok(
  (packageScript.match(/\$shared_files\b/g) ?? []).length >= 2,
  "The Chrome zip and the background-page packages must share one file list"
);
assert.ok(
  (packageScript.match(/\$shared_dirs\b/g) ?? []).length >= 2,
  "The Chrome zip and the background-page packages must share one directory list"
);

// Detection can only see a request on a host it holds permission for, and a
// video page serves its media from another domain, so access has to be asked for
// across hosts rather than for the page's own origin. Safari answers that with a
// choice between this site and every site and reports back only what was chosen,
// so the badge has to consult both.
const popupSource = fs.readFileSync("popup.js", "utf8");
assert.match(popupSource, /const allowed = await detectionAllowed\(\);/,
  "the badge must go through detectionAllowed, which checks both grants");
const allowed = popupSource.slice(
  popupSource.indexOf("async function detectionAllowed"),
  popupSource.indexOf("function formatBytes")
);
assert.match(allowed, /origins:\s*ORIGINS/, "detectionAllowed must check the cross-host grant");
assert.match(allowed, /siteOrigins\(\)/, "detectionAllowed must also check this site alone");
assert.match(popupSource, /permissions\.request\(\{ origins: accessOrigins\(\) \}\)/,
  "the request has to cover other hosts or the media is never seen");

// The popup must not read the prepared file out of storage. Doing so returned a
// zero-byte blob on Safari while the page that wrote it saw the bytes.
assert.doesNotMatch(
  popupSource,
  /navigator\.storage/,
  "the popup must ask the background page for the file, not read storage itself"
);

const localized = [];
const ariaLocalized = [];
const documentElement = { lang: "en" };
globalThis.chrome = {
  i18n: {
    getMessage: (key, substitutions) => (
      key === "@@ui_locale" ? "pt_BR" : substitutions ? `${key}:${substitutions}` : `translated:${key}`
    )
  }
};
const { formatTimeUntil, localizeDocument, t } = await import("./i18n.mjs");
localizeDocument({
  documentElement,
  querySelectorAll: (selector) => (
    selector === "[data-i18n]"
      ? [{ dataset: { i18n: "download" }, set textContent(value) { localized.push(value); } }]
      : [{
        dataset: { i18nAriaLabel: "media_views" },
        setAttribute: (name, value) => ariaLocalized.push([name, value])
      }]
  )
});
assert.equal(documentElement.lang, "pt-BR");
assert.deepEqual(localized, ["translated:download"]);
assert.deepEqual(ariaLocalized, [["aria-label", "translated:media_views"]]);
assert.equal(t("status_downloading_percent", "42"), "status_downloading_percent:42");
assert.match(formatTimeUntil("2026-01-01T00:01:30Z", Date.parse("2026-01-01T00:00:00Z")), /2/);
assert.equal(formatTimeUntil("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:01Z")), "");

console.log("presubmit policy and localization check passed");
