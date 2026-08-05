import assert from "node:assert/strict";
import fs from "node:fs";

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
assert.equal(manifest.update_url, undefined, "Store packages must not pin a browser-specific updater");

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
  "hls.mjs",
  "offscreen.js",
  "popup.html",
  "popup.js",
  "service-worker.mjs"
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

const disclosure = locales.en.privacy_disclosure.message;
for (const phrase of ["media URLs", "page titles", "download status", "request headers", "cookies", "HTTPS", "developer"]) {
  assert.ok(disclosure.includes(phrase), `Disclosure must mention ${phrase}`);
}

const packageScript = fs.readFileSync("scripts/package.sh", "utf8");
assert.match(packageScript, /\bi18n\.mjs\b/);
assert.match(packageScript, /\b_locales\b/);

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
