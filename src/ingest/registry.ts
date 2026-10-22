// Maps sources.id to its ingester. runIngesters runs every enabled source
// that has one, in sequence; one failure never stops the others.
import type { Env } from "../env";
import { epss } from "./epss";
import { kev } from "./kev";
import { nodeRuntime } from "./node-runtime";
import { nvd } from "./nvd";
import { osv } from "./osv";
import { phpRuntime } from "./php-runtime";
import { pythonRuntime } from "./python-runtime";
import type { Ingester, RunResult } from "./types";

export const defaultRegistry: Record<string, Ingester> = {
  osv,
  nvd,
  kev,
  epss,
  "node-runtime": nodeRuntime,
  "php-runtime": phpRuntime,
  "python-runtime": pythonRuntime,
};

// sources is a fixed set of rows (docs/RETENTION.md); this scan is bounded.
export const ENABLED_SOURCES_SQL = "SELECT id, kind, config_json FROM sources WHERE enabled = 1 ORDER BY id";
const MARK_OK = "UPDATE sources SET last_run_at = ?, last_ok_at = ?, last_error = NULL WHERE id = ?";
const MARK_FAILED = "UPDATE sources SET last_run_at = ?, last_error = ? WHERE id = ?";
const MAX_ERROR_CHARS = 1000;

export type SourceOutcome =
  | { source: string; status: "ok"; result: RunResult }
  | { source: string; status: "failed"; error: string; result?: RunResult }
  | { source: string; status: "skipped"; reason: string };

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function parseConfig(json: string): Record<string, unknown> {
  const v: unknown = JSON.parse(json);
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("config_json is not a JSON object");
  return v as Record<string, unknown>;
}

export async function runIngesters(env: Env, registry: Record<string, Ingester>, now: () => Date): Promise<SourceOutcome[]> {
  const { results: rows } = await env.DB.prepare(ENABLED_SOURCES_SQL).all<{ id: string; kind: string; config_json: string }>();
  const outcomes: SourceOutcome[] = [];

  for (const row of rows) {
    const ingester = Object.hasOwn(registry, row.id) ? registry[row.id] : undefined;
    let outcome: SourceOutcome;
    if (!ingester) {
      outcome = { source: row.id, status: "skipped", reason: "no ingester registered" };
      console.log(JSON.stringify({ lane: "ingest", ...outcome }));
      outcomes.push(outcome);
      continue;
    }
    try {
      const config = parseConfig(row.config_json);
      const result = await ingester.run({
        env,
        source: { id: row.id, kind: row.kind, config },
        now,
        fetch: (input, init) => fetch(input, init),
      });
      outcome =
        result.errors.length === 0
          ? { source: row.id, status: "ok", result }
          : { source: row.id, status: "failed", error: `${result.errors.length} record error(s): ${result.errors.join("; ")}`, result };
    } catch (err) {
      outcome = { source: row.id, status: "failed", error: errorText(err) };
    }

    try {
      const at = now().toISOString();
      if (outcome.status === "ok") {
        await env.DB.prepare(MARK_OK).bind(at, at, row.id).run();
      } else if (outcome.status === "failed") {
        await env.DB.prepare(MARK_FAILED).bind(at, outcome.error.slice(0, MAX_ERROR_CHARS), row.id).run();
      }
    } catch (err) {
      // The status write failing for one source must not stop the next one.
      console.log(JSON.stringify({ lane: "ingest", source: row.id, status: "status_write_failed", error: errorText(err) }));
    }
    console.log(JSON.stringify({ lane: "ingest", ...outcome }));
    outcomes.push(outcome);
  }
  return outcomes;
}
