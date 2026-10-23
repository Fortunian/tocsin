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

export type ParsedWatchlist = { ok: true; name: string; filter: WatchlistFilter } | { ok: false; error: string };

function stringList(v: unknown, field: string): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) return `${field} must be an array of strings`;
  return [...new Set((v as string[]).map((s) => s.trim()).filter((s) => s !== ""))];
}

// Validates a POST /v1/watchlists body. Wrong types are an error, never
// dropped. Lists are trimmed, emptied of blanks and deduplicated.
export function parseWatchlistBody(body: unknown): ParsedWatchlist {
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

  return { ok: true, name, filter: { ecosystems, components, runtimes, min_severity, exploited_only: b.exploited_only === true } };
}
