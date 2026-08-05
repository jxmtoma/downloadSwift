export function t(key, substitutions) {
  return globalThis.chrome?.i18n?.getMessage(key, substitutions) || key;
}

export function formatTimeUntil(estimatedEndTime, now = Date.now()) {
  const seconds = Math.ceil((new Date(estimatedEndTime).getTime() - now) / 1000);
  if (!(seconds > 0)) return "";
  const [value, unit] = seconds < 60
    ? [seconds, "second"]
    : seconds < 3600 ? [Math.ceil(seconds / 60), "minute"] : [Math.ceil(seconds / 3600), "hour"];
  const locale = t("@@ui_locale").replace("_", "-");
  return new Intl.RelativeTimeFormat(locale === "@@ui-locale" ? "en" : locale, {
    numeric: "always",
    style: "short"
  }).format(value, unit);
}

export function localizeDocument(root = document) {
  const locale = t("@@ui_locale");
  if (locale !== "@@ui_locale") root.documentElement.lang = locale.replace("_", "-");

  for (const element of root.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of root.querySelectorAll("[data-i18n-aria-label]")) {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  }
}
