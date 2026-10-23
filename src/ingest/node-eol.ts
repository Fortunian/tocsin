// The node-eol ingester (TCS-32): one advisory per Node.js release line past
// its end of life, from the nodejs/Release schedule. An end-of-life line gets
// no security fixes, so a version on it is never clean: the advisory covers
// the whole line (introduced <line>.0, last_affected the newest release of the
// line in the dist index) and has no fixed version.
import { loadNodeDistIndex } from "./node-runtime-dist";
import { compareVersions } from "./osv";
import { readRuntimeConfig } from "./runtime-text";
import type { AdvisoryInput, IngestContext, Ingester, RunResult } from "./types";
import { InvalidAdvisoryError, upsertAdvisory } from "./upsert";

const SOURCE = "node-eol";
const PREVIOUS_RELEASES = "https://nodejs.org/en/about/previous-releases";

// Code fallbacks for sources.config_json of row "node-eol" (repo iron rule 5).
export const NODE_EOL_DEFAULTS = {
  schedule_url: "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json",
  dist_index_url: "https://nodejs.org/dist/index.json",
  // Freshness window of the KV dist index cache, in seconds (shared with node-runtime).
  dist_cache_seconds: 3600,
};

export interface ScheduleLine {
  start?: string;
  lts?: string;
  end?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// "v18" -> "18", "v0.12" -> "0.12".
const LINE_KEY = /^v(\d+(?:\.\d+)?)$/;

const endMs = (l: ScheduleLine) => (typeof l.end === "string" && DAY.test(l.end) ? Date.parse(`${l.end}T00:00:00Z`) : NaN);

// The newest release of a line in the dist index ("v18.20.8" -> "18.20.8").
function newestOf(line: string, dist: Set<string>): string | undefined {
  const prefix = `v${line}.`;
  let best: string | undefined;
  for (const v of dist) {
    if (!v.startsWith(prefix)) continue;
    const x = v.slice(1);
    if (!/^\d+\.\d+\.\d+$/.test(x)) continue;
    if (best === undefined || compareVersions(x, best) > 0) best = x;
  }
  return best;
}

export function eolAdvisories(
  schedule: Record<string, ScheduleLine>,
  dist: Set<string>,
  now: Date,
  scheduleUrl: string = NODE_EOL_DEFAULTS.schedule_url,
): { docs: AdvisoryInput[]; errors: string[] } {
  const lines = Object.entries(schedule)
    .map(([key, l]) => ({ key, line: LINE_KEY.exec(key)?.[1], l }))
    .filter((x): x is { key: string; line: string; l: ScheduleLine } => x.line !== undefined);
  // The upgrade target: the lowest even (LTS) line that has started and is not past its end.
  const supported = lines
    .filter((x) => !x.line.includes(".") && Number(x.line) % 2 === 0)
    .filter((x) => typeof x.l.start === "string" && Date.parse(`${x.l.start}T00:00:00Z`) <= now.getTime() && endMs(x.l) > now.getTime())
    .map((x) => Number(x.line))
    .sort((a, b) => a - b)[0];
  const docs: AdvisoryInput[] = [];
  const errors: string[] = [];
  if (supported === undefined) return { docs, errors: ["no supported LTS line in the schedule"] };
  for (const { key, line, l } of lines) {
    const end = endMs(l);
    if (Number.isNaN(end) || end >= now.getTime()) continue;
    const last = newestOf(line, dist);
    if (last === undefined) {
      // No guessed range (iron rule 10): the line waits for a dist index that lists it.
      errors.push(`${key}: no ${line}.x release in the dist index, not emitted`);
      continue;
    }
    const published = `${l.end}T00:00:00Z`;
    docs.push({
      cve_ids: [],
      ecosystem: "node",
      component: "node",
      affected: [{ introduced: line.includes(".") ? `${line}.0` : `${line}.0.0`, last_affected: last }],
      fixed_versions: [],
      severity: { label: "high" },
      exploited: false,
      published_at: published,
      modified_at: published,
      summary: `Node.js ${line}.x is end of life (since ${l.end}). It gets no security fixes.`,
      action: `Upgrade node to ${supported}.x or later.`,
      references: [scheduleUrl, PREVIOUS_RELEASES],
      sources: [{ source: SOURCE, source_id: `eol-${line}`, url: PREVIOUS_RELEASES }],
    });
  }
  return { docs, errors };
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const cfg = readRuntimeConfig(SOURCE, ctx.source.config, NODE_EOL_DEFAULTS);
  const now = ctx.now();
  // HTTP errors throw out of the run: nothing is written.
  const res = await ctx.fetch(cfg.schedule_url, { headers: { "User-Agent": "tocsin.sh" } });
  if (!res.ok) throw new Error(`node-eol: HTTP ${res.status} for ${cfg.schedule_url}`);
  const schedule: unknown = JSON.parse(await res.text());
  if (schedule === null || typeof schedule !== "object" || Array.isArray(schedule)) throw new Error(`node-eol: ${cfg.schedule_url} is not a JSON object`);
  const dist = await loadNodeDistIndex(ctx.fetch, ctx.env.CURSORS, cfg.dist_index_url, cfg.dist_cache_seconds, now, false);
  const { docs, errors } = eolAdvisories(schedule as Record<string, ScheduleLine>, dist.versions, now, cfg.schedule_url);
  const result: RunResult = { fetched: docs.length, upserted: 0, unchanged: 0, errors: [...errors] };
  for (const doc of docs) {
    try {
      const outcome = await upsertAdvisory(ctx.env.DB, doc, { source: SOURCE, source_id: doc.sources[0].source_id });
      if (outcome === "unchanged") result.unchanged += 1;
      else result.upserted += 1;
    } catch (err) {
      if (!(err instanceof InvalidAdvisoryError)) throw err;
      result.errors.push(`${doc.sources[0].source_id}: ${err.message}`);
    }
  }
  return result;
}

export const nodeEol: Ingester = { id: SOURCE, run };
