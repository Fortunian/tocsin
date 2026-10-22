import type { Env } from "../env";
import type { Advisory } from "../schema/advisory";

// One ingester run. `upserted` counts inserted + updated advisories.
// A non-empty `errors` marks the run as failed in `sources.last_error`.
export interface RunResult {
  fetched: number;
  upserted: number;
  unchanged: number;
  errors: string[];
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
