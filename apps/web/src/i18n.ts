import type { Locale, Strings } from "./types";

export function t(strings: Strings, key: string, params?: Record<string, string | number>): string {
  let text = strings[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

export function detectLocale(): Locale {
  const stored = localStorage.getItem("lv_locale");
  if (stored === "en" || stored === "zh-CN") return stored;
  return "zh-CN";
}

export function persistLocale(locale: Locale): void {
  localStorage.setItem("lv_locale", locale);
}
