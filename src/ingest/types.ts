import type { Env } from "../env";
import type { Advisory } from "../schema/advisory";

// One ingester run. `upserted` counts inserted + updated advisories.
// A non-empty `errors` marks the run as failed in `sources.last_error`.
export interface RunResult {
  fetched: number;
  upserted: number;
  unchanged: number;
  errors: string[];
  // Work this run saw and left for a later run (a per-run cap). `deferred` is
  // the count where the ingester measured it; `incomplete` says more remains.
  deferred?: number;
  incomplete?: boolean;
  // Notes an operator must see that do not fail the run (sources.last_warning).
  // Absent or empty keeps the stored last_warning.
  warnings?: string[];
}

// The `sources` row the ingester runs for, with `config_json` parsed.
export interface SourceRow {
  id: string;
  kind: string;
  config: Record<string, unknown>;
}

export interface IngestContext {
  env: Env;
  source: SourceRow;
  now: () => Date;
  fetch: typeof fetch;
}

export interface Ingester {
  id: string;
  run(ctx: IngestContext): Promise<RunResult>;
}

// An advisory as an ingester produces it. upsertAdvisory assigns the id.
export type AdvisoryInput = Omit<Advisory, "id">;
