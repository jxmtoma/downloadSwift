export function t(key, substitutions) {
  return globalThis.chrome?.i18n?.getMessage(key, substitutions) || key;
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
