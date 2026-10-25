import { GREEN, flatBadge } from "./badge";
import { escapeHtml } from "./layout";

// The home page freshness line and the README badge (TCS-35). Built from
// loadStatus: `updated` is the newest last_ok_at over the enabled sources, and a
// source is ok when it has had a good run and its last run left no error.
export interface Freshness {
  updated: string | null;
  ok: number;
  total: number;
}

const AMBER = "#f5a524";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

// "5 minutes ago", rendered on the server. A time in the future (clock skew)
// reads "just now". Null when the value is not a date.
export function relativeTime(iso: string, nowMs: number): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const ms = nowMs - at;
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return plural(Math.floor(ms / HOUR), "hour");
  return plural(Math.floor(ms / DAY), "day");
}

function healthy(f: Freshness): boolean {
  return f.total > 0 && f.ok === f.total;
}

function updatedHtml(updated: string | null, nowMs: number): string {
  const rel = updated === null ? null : relativeTime(updated, nowMs);
  if (updated === null || rel === null) return "never";
  const iso = escapeHtml(updated);
  return `<time datetime="${iso}" title="${iso}">${rel}</time>`;
}

// "Updated <time> · 6 of 6 sources ok". Any source not ok turns the line amber
// and links the count to /status. Null (status not readable) renders nothing.
export function renderFreshness(f: Freshness | null, nowMs: number): string {
  if (f === null) return "";
  const count = `${f.ok} of ${f.total} sources ok`;
  const updated = updatedHtml(f.updated, nowMs);
  if (healthy(f)) return `<p class="fresh">Updated ${updated} · ${count}</p>`;
  return `<p class="fresh" style="color:${AMBER}">Updated ${updated} · <a href="/status" style="color:inherit">${count}</a></p>`;
}

// A flat two-part badge: "tocsin" | "6/6 sources ok" (green) or "degraded" (amber).
export function renderBadge(f: Freshness): string {
  const label = "tocsin";
  const ratio = `${f.ok}/${f.total} sources ok`;
  const value = healthy(f) ? ratio : "degraded";
  const title = healthy(f) ? `${label} · ${ratio}` : `${label} · degraded (${ratio})`;
  return flatBadge(label, value, healthy(f) ? GREEN : AMBER, title);
}
