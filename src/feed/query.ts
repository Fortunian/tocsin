import type { SeverityLabel } from "../schema/advisory";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
// Keeps the bound parameters well under D1's 100-per-statement cap.
export const MAX_LIST_ITEMS = 20;

const SEVERITY_ORDER: Exclude<SeverityLabel, "unknown">[] = ["critical", "high", "medium", "low"];

export interface EventsFilters {
  since: number;
  limit: number;
  ecosystem: string[];
  component: string[];
  min_severity: Exclude<SeverityLabel, "unknown"> | null;
  exploited: boolean;
  // asc (default): oldest first from since. desc: newest first, still cursor > since.
  order: "asc" | "desc";
}

export type ParseResult = { ok: true; filters: EventsFilters } | { ok: false; error: string };

function parseCsv(raw: string | null, name: string): string[] | string {
  if (raw === null) return [];
  const items = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
  if (items.length > MAX_LIST_ITEMS) return `${name} accepts at most ${MAX_LIST_ITEMS} values`;
  return items;
}

export function parseEventsFilters(url: URL): ParseResult {
  const q = url.searchParams;

  const sinceRaw = q.get("since");
  let since = 0;
  if (sinceRaw !== null) {
    if (!/^\d+$/.test(sinceRaw) || !Number.isSafeInteger(Number(sinceRaw))) {
      return { ok: false, error: "since must be a non-negative integer cursor" };
    }
    since = Number(sinceRaw);
  }

  const limitRaw = q.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    if (!/^-?\d+$/.test(limitRaw)) return { ok: false, error: "limit must be an integer" };
    limit = Math.min(MAX_LIMIT, Math.max(1, Number(limitRaw)));
  }

  const ecosystem = parseCsv(q.get("ecosystem"), "ecosystem");
  if (typeof ecosystem === "string") return { ok: false, error: ecosystem };
  const component = parseCsv(q.get("component"), "component");
  if (typeof component === "string") return { ok: false, error: component };

  const sevRaw = q.get("min_severity");
  let min_severity: EventsFilters["min_severity"] = null;
  if (sevRaw !== null) {
    const found = SEVERITY_ORDER.find((s) => s === sevRaw);
    if (!found) return { ok: false, error: `min_severity must be one of ${SEVERITY_ORDER.join(", ")}` };
    min_severity = found;
  }

  const exploitedRaw = q.get("exploited");
  if (exploitedRaw !== null && exploitedRaw !== "true") {
    return { ok: false, error: "exploited accepts only true" };
  }

  const orderRaw = q.get("order");
  if (orderRaw !== null && orderRaw !== "asc" && orderRaw !== "desc") {
    return { ok: false, error: "order must be asc or desc" };
  }
  const order = orderRaw ?? "asc";

  return { ok: true, filters: { since, limit, ecosystem, component, min_severity, exploited: exploitedRaw === "true", order } };
}

// One statement, 2 columns. Fetches limit + 1 rows so the route can tell
// whether another page exists without a COUNT.
export function buildEventsQuery(f: EventsFilters): { sql: string; params: unknown[] } {
  const where = ["cursor > ?"];
  const params: unknown[] = [f.since];
  const inList = (col: string, values: string[]) => {
    where.push(`${col} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  };
  if (f.ecosystem.length) inList("ecosystem", f.ecosystem);
  if (f.component.length) inList("component", f.component);
  if (f.min_severity) inList("severity_label", SEVERITY_ORDER.slice(0, SEVERITY_ORDER.indexOf(f.min_severity) + 1));
  if (f.exploited) where.push("exploited = 1");
  const sql = `SELECT cursor, doc_json FROM advisories WHERE ${where.join(" AND ")} ORDER BY cursor${f.order === "desc" ? " DESC" : ""} LIMIT ${f.limit + 1}`;
  return { sql, params };
}
