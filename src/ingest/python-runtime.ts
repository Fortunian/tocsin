// The python-runtime ingester (CPython). Source: the PSF advisory database
// (psf/advisory-database, advisories/python/PSF-YYYY-N.json, OSV format).
// The python/cpython GitHub security-advisories endpoint is empty (checked
// 2026-10-22), so it is not read. A PSF record names the CVE; the PSF CVE
// record gives the fixed version per release line; python.org releases
// confirm each fix is released. One advisory per PSF record (one CVE).
//
// Per run: 1 GitHub listing call (conditional on the stored ETag). Every
// listed id is checked against python_runtime_records in one batched read;
// ids with no row, and failed rows that are due, are read (newest first, at
// most max_records). Each record ends in a persisted state: ok, empty
// (terminal), pending (a fix not on python.org yet) or failed (retried on
// retry_schedule_minutes up to max_attempts reads, then terminal). One record
// never stops the run; a terminal record is reported once, by the run that
// makes it terminal, and is then visible only in the ledger.
import { fetchCveRecord, fetchListing, fetchPsfRecord, fetchReleases } from "./python-runtime-client";
import { comparePsfIds, normalizePythonAdvisory, parsePsfListing, parsePythonReleases, publishedDoc, readPsf } from "./python-runtime-normalize";
import { attemptsOf, dueRows, knownIds, readPendingState, writeRecord, type PendingState, type RecordRow } from "./python-runtime-records";
import { readRuntimeConfig } from "./runtime-text";
import type { AdvisoryInput, IngestContext, Ingester, RunResult } from "./types";
import { InvalidAdvisoryError, upsertAdvisory } from "./upsert";

export { comparePsfIds, lineRanges, normalizePythonAdvisory, parsePsfListing, parsePythonReleases, publishedDoc } from "./python-runtime-normalize";
export { RECORD_SQL } from "./python-runtime-records";

export const PY_ETAG_KEY = "python:listing-etag";
const SOURCE = "python-runtime";
// The GitHub contents API returns at most 1,000 entries for one directory.
export const LISTING_LIMIT = 1000;

// Code fallbacks for sources.config_json of row "python-runtime" (repo iron rule 5).
export const PY_DEFAULTS = {
  listing_url: "https://api.github.com/repos/psf/advisory-database/contents/advisories/python",
  record_base: "https://raw.githubusercontent.com/psf/advisory-database/main/advisories/python",
  html_base: "https://github.com/psf/advisory-database/blob/main/advisories/python",
  cve_api_base: "https://cveawg.mitre.org/api/cve",
  releases_url: "https://www.python.org/api/v2/downloads/release/?is_published=true",
  min_line: "3.9",
  max_records: 50,
  max_attempts: 10,
  // Wait after attempt 1, 2, 3, ...; the last value repeats (1 hour, 6 hours, 24 hours, then weekly).
  retry_schedule_minutes: "60,360,1440,10080",
  pending_recheck_minutes: 60,
  pending_max_days: 90,
};
type PyConfig = typeof PY_DEFAULTS;

interface RunState {
  ctx: IngestContext;
  cfg: PyConfig;
  now: Date;
  result: RunResult;
  released: Set<string>;
  pending: number;
}

const minutesFrom = (now: Date, minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

function readConfig(raw: Record<string, unknown>): PyConfig {
  const cfg = readRuntimeConfig(SOURCE, raw, PY_DEFAULTS);
  if (!/^\d+\.\d+$/.test(cfg.min_line)) throw new Error(`${SOURCE} config: min_line must look like "3.9"`);
  if (!/^[1-9]\d*(,[1-9]\d*)*$/.test(cfg.retry_schedule_minutes)) throw new Error(`${SOURCE} config: retry_schedule_minutes must be a comma list of positive integers`);
  return cfg;
}

// The wait after failed attempt n (1-based) on the retry schedule; the last value repeats.
export function retryWaitMinutes(schedule: string, attempt: number): number {
  const waits = schedule.split(",").map(Number);
  return waits[Math.min(attempt, waits.length) - 1];
}

async function store(state: RunState, doc: AdvisoryInput): Promise<boolean> {
  try {
    const outcome = await upsertAdvisory(state.ctx.env.DB, doc, { source: SOURCE, source_id: doc.sources[0].source_id });
    if (outcome === "unchanged") state.result.unchanged += 1;
    else state.result.upserted += 1;
    return true;
  } catch (err) {
    if (!(err instanceof InvalidAdvisoryError)) throw err;
    state.result.errors.push(`${doc.sources[0].source_id}: ${err.message}`);
    return false;
  }
}

// Publishes every affected range at once and writes the row. While a fix is
// not on python.org the row is pending and the action says so; the re-check
// rewrites the action once the fix is released.
async function settle(state: RunState, psfId: string, p: PendingState): Promise<void> {
  const { cfg, now } = state;
  const db = state.ctx.env.DB;
  const waiting = p.lines.filter((l) => !state.released.has(l.fixed));
  const stale = waiting.filter((l) => now.getTime() - new Date(l.since).getTime() >= cfg.pending_max_days * 86_400_000);
  const pending = { ...p, lines: waiting.filter((l) => !stale.includes(l)), dropped: [...p.dropped, ...stale.map((l) => l.fixed)] };
  const open = pending.lines.map((l) => l.fixed);
  const quiet = pending.dropped.filter((f) => !state.released.has(f) && !open.includes(f));
  const note = quiet.length === 0 ? undefined : `no python.org release after ${cfg.pending_max_days} days: ${quiet.join(", ")}`;
  const cve = p.doc.cve_ids[0];
  if (!(await store(state, publishedDoc(p.doc, open, quiet)))) {
    return writeRecord(db, { psf_id: psfId, state: "empty", attempts: 0, last_error: "advisory failed validation", cve }, now);
  }
  if (open.length > 0) {
    state.pending += 1;
    return writeRecord(db, { psf_id: psfId, state: "pending", attempts: 0, last_error: note, cve, unreleased: pending, next_check_at: minutesFrom(now, cfg.pending_recheck_minutes) }, now);
  }
  await writeRecord(db, { psf_id: psfId, state: "ok", attempts: 0, last_error: note, cve }, now);
}

// Reads one PSF record and its CVE record. A read or parse error is a failed
// attempt; a record that yields no advisory is terminal empty.
async function handleRecord(state: RunState, psfId: string): Promise<void> {
  const { ctx, cfg, now, result } = state;
  const db = ctx.env.DB;
  let norm: ReturnType<typeof normalizePythonAdvisory>;
  try {
    const psf = await fetchPsfRecord(ctx.fetch, cfg.record_base, psfId);
    result.fetched += 1;
    const facts = readPsf(psfId, psf);
    norm = facts.ok ? normalizePythonAdvisory(psfId, psf, await fetchCveRecord(ctx.fetch, cfg.cve_api_base, facts.cve), { minLine: cfg.min_line, htmlBase: cfg.html_base }) : facts;
  } catch (err) {
    const attempts = (await attemptsOf(db, psfId)) + 1;
    const terminal = attempts >= cfg.max_attempts;
    // The one report of a terminal record: this run's errors. Later runs stay ok.
    if (terminal) result.errors.push(`${psfId}: failed terminally after ${attempts} attempts: ${errorText(err)}`);
    const next_check_at = terminal ? undefined : minutesFrom(now, retryWaitMinutes(cfg.retry_schedule_minutes, attempts));
    return writeRecord(db, { psf_id: psfId, state: "failed", attempts, last_error: errorText(err), next_check_at }, now);
  }
  if (!norm.ok) {
    if (norm.error) result.errors.push(norm.reason);
    return writeRecord(db, { psf_id: psfId, state: "empty", attempts: 0, last_error: norm.reason }, now);
  }
  const since = now.toISOString();
  await settle(state, psfId, { doc: norm.doc, lines: norm.doc.fixed_versions.map((fixed) => ({ fixed, since })), dropped: [] });
}

async function recheck(state: RunState, row: RecordRow): Promise<void> {
  const p = readPendingState(row.unreleased);
  if (p !== undefined) return settle(state, row.psf_id, p);
  state.result.errors.push(`${row.psf_id}: unreadable pending state`);
  await writeRecord(state.ctx.env.DB, { psf_id: row.psf_id, state: "empty", attempts: 0, last_error: "unreadable pending state" }, state.now);
}

interface Work {
  records: string[];
  pending: RecordRow[];
  capped: boolean;
}

// New ids (no row) and due failed rows, newest first, capped; plus due pending rows.
async function planWork(state: RunState, listed: string[]): Promise<Work> {
  const { cfg, now } = state;
  const db = state.ctx.env.DB;
  const known = await knownIds(db, listed);
  const retries = (await dueRows(db, "failed", now, cfg.max_records + 1)).map((r) => r.psf_id);
  const all = [...new Set([...listed.filter((id) => !known.has(id)), ...retries])].sort(comparePsfIds).reverse();
  const pending = await dueRows(db, "pending", now, cfg.max_records);
  return { records: all.slice(0, cfg.max_records), pending, capped: all.length > cfg.max_records };
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const cfg = readConfig(ctx.source.config);
  const kv = ctx.env.CURSORS;
  const now = ctx.now();
  const state: RunState = { ctx, cfg, now, result: { fetched: 0, upserted: 0, unchanged: 0, errors: [] }, released: new Set(), pending: 0 };
  const etag = await kv.get(PY_ETAG_KEY);
  // A listing error throws out of the run: nothing was read, nothing changes.
  const listing = await fetchListing(ctx.fetch, cfg.listing_url, ctx.env.GITHUB_TOKEN, etag ?? undefined);
  let listed: string[] = [];
  if (!listing.notModified) {
    if (Array.isArray(listing.body) && listing.body.length >= LISTING_LIMIT) state.result.errors.push(`listing truncated at ${LISTING_LIMIT} entries`);
    listed = parsePsfListing(listing.body);
  }
  const work = await planWork(state, listed);
  // One python.org read per run, before any record read; its error throws before any vendor spend.
  if (work.records.length + work.pending.length > 0) state.released = parsePythonReleases(await fetchReleases(ctx.fetch, cfg.releases_url));
  for (const id of work.records) await handleRecord(state, id);
  for (const row of work.pending) await recheck(state, row);
  await finish(state, listing, work.capped);
  return state.result;
}

async function finish(state: RunState, listing: Awaited<ReturnType<typeof fetchListing>>, capped: boolean): Promise<void> {
  const kv = state.ctx.env.CURSORS;
  // The ETag is kept only when this run read every new id, so a 304 never hides unread records.
  if (!listing.notModified) {
    if (capped || listing.etag === undefined) await kv.delete(PY_ETAG_KEY);
    else await kv.put(PY_ETAG_KEY, listing.etag);
  }
  if (state.pending > 0) state.result.deferred = state.pending;
  if (capped || state.pending > 0) state.result.incomplete = true;
}

export const pythonRuntime: Ingester = { id: SOURCE, run };
