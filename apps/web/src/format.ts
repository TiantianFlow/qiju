import type { Locale } from "./types";

const NUMBER_FORMATTERS: Record<Locale, Intl.NumberFormat> = {
  "zh-CN": new Intl.NumberFormat("zh-CN"),
  en: new Intl.NumberFormat("en-US"),
};

/** Thousands-grouped display string for money-like values (item values, bids, budgets, profit). */
export function formatNumber(value: number, locale: Locale): string {
  return (NUMBER_FORMATTERS[locale] ?? NUMBER_FORMATTERS["zh-CN"]).format(value);
}
