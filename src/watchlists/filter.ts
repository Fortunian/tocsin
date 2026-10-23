import { isMinSeverity, type MinSeverity } from "../feed/query";

// The stored filter of one watch list (watchlists.filter_json).
export interface WatchlistFilter {
  ecosystems: string[];
  components: string[];
  // Runtime name -> version. The names join the ecosystem set (a runtime name
  // is an ecosystem); the version is stored, not range-matched.
  runtimes: Record<string, string>;
  min_severity: MinSeverity | null;
  exploited_only: boolean;
}

// How a list is delivered: polled (GET /:id/events) or POSTed to webhook_url.
export type DeliverySetting = { delivery: "poll"; webhook_url: null } | { delivery: "webhook"; webhook_url: string };

export type ParsedWatchlist = { ok: true; name: string; filter: WatchlistFilter; delivery: DeliverySetting } | { ok: false; error: string };

// Code fallback only. The live value is settings.webhooks.max_url_length.
export const FALLBACK_MAX_URL_LENGTH = 2048;

// Reads delivery and webhook_url. delivery is "poll" (the default when absent)
// or "webhook", exact case. webhook needs an https URL with no user or
// password, at most maxUrlLength characters. webhook_url without
// delivery "webhook" is an error, never dropped.
export function parseDelivery(b: Record<string, unknown>, maxUrlLength: number): { ok: true; value: DeliverySetting } | { ok: false; error: string } {
  const d = b.delivery === undefined ? "poll" : b.delivery;
  if (d !== "poll" && d !== "webhook") return { ok: false, error: "delivery must be poll or webhook" };
  if (d === "poll") {
    if (b.webhook_url !== undefined && b.webhook_url !== null) return { ok: false, error: "webhook_url is only for delivery webhook" };
    return { ok: true, value: { delivery: "poll", webhook_url: null } };
  }
  if (typeof b.webhook_url !== "string" || b.webhook_url.trim() === "") return { ok: false, error: "webhook_url is required for delivery webhook" };
  const raw = b.webhook_url.trim();
  if (raw.length > maxUrlLength) return { ok: false, error: `webhook_url must be at most ${maxUrlLength} characters` };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "webhook_url must be a URL" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "webhook_url must use https" };
  if (u.username !== "" || u.password !== "") return { ok: false, error: "webhook_url must not hold a user name or password" };
  return { ok: true, value: { delivery: "webhook", webhook_url: raw } };
}

function stringList(v: unknown, field: string): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) return `${field} must be an array of strings`;
  return [...new Set((v as string[]).map((s) => s.trim()).filter((s) => s !== ""))];
}

// Validates a POST /v1/watchlists body. Wrong types are an error, never
// dropped. Lists are trimmed, emptied of blanks and deduplicated.
export function parseWatchlistBody(body: unknown, maxUrlLength: number = FALLBACK_MAX_URL_LENGTH): ParsedWatchlist {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name === "") return { ok: false, error: "name must be a non-empty string" };

  const ecosystems = stringList(b.ecosystems, "ecosystems");
  if (typeof ecosystems === "string") return { ok: false, error: ecosystems };
  const components = stringList(b.components, "components");
  if (typeof components === "string") return { ok: false, error: components };

  const runtimes: Record<string, string> = {};
  if (b.runtimes !== undefined) {
    if (b.runtimes === null || typeof b.runtimes !== "object" || Array.isArray(b.runtimes)) {
      return { ok: false, error: "runtimes must be an object of runtime name to version" };
    }
    for (const [k, v] of Object.entries(b.runtimes)) {
      if (typeof v !== "string") return { ok: false, error: "runtimes must be an object of runtime name to version" };
      if (k.trim() !== "") runtimes[k.trim()] = v.trim();
    }
  }

  let min_severity: MinSeverity | null = null;
  if (b.min_severity !== undefined && b.min_severity !== null) {
    if (!isMinSeverity(b.min_severity)) return { ok: false, error: "min_severity must be one of critical, high, medium, low" };
    min_severity = b.min_severity;
  }

  if (b.exploited_only !== undefined && typeof b.exploited_only !== "boolean") {
    return { ok: false, error: "exploited_only must be a boolean" };
  }

  const delivery = parseDelivery(b, maxUrlLength);
  if (!delivery.ok) return delivery;

  return {
    ok: true,
    name,
    filter: { ecosystems, components, runtimes, min_severity, exploited_only: b.exploited_only === true },
    delivery: delivery.value,
  };
}
