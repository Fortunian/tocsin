import { isMinSeverity, type MinSeverity } from "../feed/query";
import { DEFAULT_ECOSYSTEMS } from "../ingest/osv";

// Input caps. They bound one stored row and, with plans.max_watchlists, the
// GET /v1/watchlists answer. The component count cap is plans.max_components.
export const MAX_NAME_CHARS = 100;
export const MAX_STRING_CHARS = 200;
export const MAX_ECOSYSTEMS = 20;
export const MAX_RUNTIMES = 10;
export const MAX_FILTER_BYTES = 65_536;
// The OSV ecosystems we ingest plus the runtime names (CLAUDE.md, Naming).
export const KNOWN_ECOSYSTEMS: ReadonlySet<string> = new Set([...DEFAULT_ECOSYSTEMS, "node", "php", "python", "go", "deno", "bun"]);

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
  const list = [...new Set((v as string[]).map((s) => s.trim()).filter((s) => s !== ""))];
  if (list.some((s) => s.length > MAX_STRING_CHARS)) return `${field}: each value must be at most ${MAX_STRING_CHARS} characters`;
  return list;
}

function checkEcosystems(list: string[]): string | null {
  if (list.length > MAX_ECOSYSTEMS) return `ecosystems: at most ${MAX_ECOSYSTEMS} values`;
  const unknown = list.find((e) => !KNOWN_ECOSYSTEMS.has(e));
  if (unknown !== undefined) return `ecosystems: unknown value ${JSON.stringify(unknown)}; known: ${[...KNOWN_ECOSYSTEMS].join(", ")}`;
  return null;
}

function parseRuntimes(v: unknown): Record<string, string> | string {
  const runtimes: Record<string, string> = {};
  if (v === undefined) return runtimes;
  const shape = "runtimes must be an object of runtime name to version";
  if (v === null || typeof v !== "object" || Array.isArray(v)) return shape;
  for (const [k, ver] of Object.entries(v)) {
    if (typeof ver !== "string") return shape;
    if (k.trim().length > MAX_STRING_CHARS || ver.trim().length > MAX_STRING_CHARS) {
      return `runtimes: each name and version must be at most ${MAX_STRING_CHARS} characters`;
    }
    if (k.trim() !== "") runtimes[k.trim()] = ver.trim();
  }
  if (Object.keys(runtimes).length > MAX_RUNTIMES) return `runtimes: at most ${MAX_RUNTIMES} entries`;
  return runtimes;
}

// Validates a POST /v1/watchlists body. Wrong types are an error, never
// dropped. Lists are trimmed, emptied of blanks and deduplicated.
export function parseWatchlistBody(body: unknown): ParsedWatchlist {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name === "") return { ok: false, error: "name must be a non-empty string" };
  if (name.length > MAX_NAME_CHARS) return { ok: false, error: `name must be at most ${MAX_NAME_CHARS} characters` };

  const ecosystems = stringList(b.ecosystems, "ecosystems");
  if (typeof ecosystems === "string") return { ok: false, error: ecosystems };
  const ecoError = checkEcosystems(ecosystems);
  if (ecoError) return { ok: false, error: ecoError };
  const components = stringList(b.components, "components");
  if (typeof components === "string") return { ok: false, error: components };

  const runtimes = parseRuntimes(b.runtimes);
  if (typeof runtimes === "string") return { ok: false, error: runtimes };

  let min_severity: MinSeverity | null = null;
  if (b.min_severity !== undefined && b.min_severity !== null) {
    if (!isMinSeverity(b.min_severity)) return { ok: false, error: "min_severity must be one of critical, high, medium, low" };
    min_severity = b.min_severity;
  }

  if (b.exploited_only !== undefined && typeof b.exploited_only !== "boolean") {
    return { ok: false, error: "exploited_only must be a boolean" };
  }

  const filter = { ecosystems, components, runtimes, min_severity, exploited_only: b.exploited_only === true };
  const bytes = new TextEncoder().encode(JSON.stringify(filter)).length;
  if (bytes > MAX_FILTER_BYTES) return { ok: false, error: `filter: at most ${MAX_FILTER_BYTES} bytes as JSON, got ${bytes}` };
  return { ok: true, name, filter };
}
