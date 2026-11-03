import i18n from "../i18n";

const locale = () => (i18n.language === "en" ? "en-GB" : "fr-FR");

export function formatDate(value: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale(), opts).format(new Date(value));
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "—";
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  if (abs < 60) return i18n.t("time.justNow");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 7 * 86_400) return rtf.format(Math.round(diff / 86_400), "day");
  return formatDate(value, { dateStyle: "medium" });
}

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale(), opts).format(n);
}

export function formatPrice(price: number | null | undefined, currency = "TND"): string {
  if (price == null) return "—";
  return `${formatNumber(price, { maximumFractionDigits: 3 })} ${currency}`;
}

/** "a, b , c" ⇄ ["a","b","c"] */
export const splitList = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);
export const joinList = (xs: string[]): string => xs.join(", ");
