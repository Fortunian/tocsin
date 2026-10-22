// The python-runtime ingester (CPython). Source: the PSF advisory database
// (psf/advisory-database, advisories/python/PSF-YYYY-N.json, OSV format).
// The python/cpython GitHub security-advisories endpoint is empty (checked
// 2026-10-22), so it is not read. A PSF record names the CVE; the PSF CVE
// record gives the fixed version per release line; python.org releases
// confirm each fix is released. One advisory per PSF record (one CVE).
//
// Per run: 1 GitHub listing call (conditional on the stored ETag), then for
// each new PSF id after the KV cursor, at most max_records: a D1 dedup seek,
// the PSF record, the CVE record. A fix not on python.org yet is a pending KV
// record (deferred, not an error), re-checked on later runs.
import { fetchCveRecord, fetchListing, fetchPsfRecord, fetchReleases } from "./python-runtime-client";
import { comparePsfIds, normalizePythonAdvisory, parsePsfListing, parsePythonReleases, PSF_ID, readPsf } from "./python-runtime-normalize";
import { readRuntimeConfig } from "./runtime-text";
import type { AdvisoryInput, IngestContext, Ingester, RunResult } from "./types";
import { InvalidAdvisoryError, upsertAdvisory } from "./upsert";

export { comparePsfIds, lineRanges, normalizePythonAdvisory, parsePsfListing, parsePythonReleases } from "./python-runtime-normalize";

// KV keys: the last handled PSF id, the listing ETag, one pending record per PSF id.
export const PY_CURSOR_KEY = "cursor:python-runtime";
export const PY_ETAG_KEY = "python:listing-etag";
export const PY_PENDING_PREFIX = "python:pending:";
const SOURCE = "python-runtime";

// Dedup before any read of a record: one seek on the advisory_sources primary key.
export const PY_DEDUP_SQL = "SELECT 1 AS hit FROM advisory_sources WHERE source = ? AND source_id = ?";

// Code fallbacks for sources.config_json of row "python-runtime" (repo iron rule 5).
export const PY_DEFAULTS = {
  listing_url: "https://api.github.com/repos/psf/advisory-database/contents/advisories/python",
  record_base: "https://raw.githubusercontent.com/psf/advisory-database/main/advisories/python",
  html_base: "https://github.com/psf/advisory-database/blob/main/advisories/python",
  cve_api_base: "https://cveawg.mitre.org/api/cve",
  releases_url: "https://www.python.org/api/v2/downloads/release/?is_published=true",
  min_line: "3.9",
  backfill_days: 120,
  max_records: 50,
  pending_ttl_days: 7,
};
type PyConfig = typeof PY_DEFAULTS;

export interface PendingRecord {
  psf: string;
  cve: string;
  unreleased: string[];
  doc: AdvisoryInput;
}

interface RunState {
  ctx: IngestContext;
  cfg: PyConfig;
  result: RunResult;
  released?: Set<string>;
  deferred: number;
}

function readConfig(raw: Record<string, unknown>): PyConfig {
  const cfg = readRuntimeConfig(SOURCE, raw, PY_DEFAULTS);
  if (!/^\d+\.\d+$/.test(cfg.min_line)) throw new Error(`${SOURCE} config: min_line must look like "3.9"`);
  return cfg;
}

// The ids after the cursor; with no valid cursor, the ids of the backfill window's years.
function newIds(ids: string[], cursor: string | null, now: Date, backfillDays: number): string[] {
  if (cursor !== null && PSF_ID.test(cursor)) return ids.filter((id) => comparePsfIds(id, cursor) > 0);
  const floor = new Date(now.getTime() - backfillDays * 86_400_000).getUTCFullYear();
  return ids.filter((id) => Number(PSF_ID.exec(id)![1]) >= floor);
}

async function isStored(state: RunState, psfId: string): Promise<boolean> {
  return (await state.ctx.env.DB.prepare(PY_DEDUP_SQL).bind(SOURCE, psfId).first()) !== null;
}

async function store(state: RunState, doc: AdvisoryInput): Promise<void> {
  const key = doc.sources[0];
  try {
    const outcome = await upsertAdvisory(state.ctx.env.DB, doc, { source: SOURCE, source_id: key.source_id });
    if (outcome === "unchanged") state.result.unchanged += 1;
    else state.result.upserted += 1;
  } catch (err) {
    if (!(err instanceof InvalidAdvisoryError)) throw err;
    state.result.errors.push(`${key.source_id}: ${err.message}`);
  }
}

// Stores the doc when every fixed version is released; else writes (or refreshes) its pending record.
async function settle(state: RunState, psfId: string, doc: AdvisoryInput): Promise<void> {
  const { ctx, cfg } = state;
  state.released ??= parsePythonReleases(await fetchReleases(ctx.fetch, cfg.releases_url));
  const unreleased = doc.fixed_versions.filter((v) => !state.released!.has(v));
  const key = PY_PENDING_PREFIX + psfId;
  if (unreleased.length === 0) {
    await store(state, doc);
    await ctx.env.CURSORS.delete(key);
    return;
  }
  const pending: PendingRecord = { psf: psfId, cve: doc.cve_ids[0], unreleased, doc };
  await ctx.env.CURSORS.put(key, JSON.stringify(pending), { expirationTtl: cfg.pending_ttl_days * 86_400 });
  state.deferred += 1;
}

async function handleNew(state: RunState, psfId: string): Promise<void> {
  const { ctx, cfg, result } = state;
  if (await isStored(state, psfId)) {
    result.unchanged += 1;
    return;
  }
  const psf = await fetchPsfRecord(ctx.fetch, cfg.record_base, psfId);
  result.fetched += 1;
  const facts = readPsf(psfId, psf);
  if (!facts.ok) {
    if (facts.error) result.errors.push(facts.reason);
    return;
  }
  const cve = await fetchCveRecord(ctx.fetch, cfg.cve_api_base, facts.cve);
  const norm = normalizePythonAdvisory(psfId, psf, cve, { minLine: cfg.min_line, htmlBase: cfg.html_base });
  if (norm.ok) await settle(state, psfId, norm.doc);
  else if (norm.error) result.errors.push(norm.reason);
}

function readPending(text: string | null): PendingRecord | undefined {
  if (text === null) return undefined;
  try {
    const p = JSON.parse(text) as PendingRecord;
    return typeof p?.psf === "string" && PSF_ID.test(p.psf) && p.doc !== null && typeof p.doc === "object" ? p : undefined;
  } catch {
    return undefined;
  }
}

// Pending records need only the releases list: the doc is kept in the record.
async function recheckPending(state: RunState): Promise<void> {
  const kv = state.ctx.env.CURSORS;
  for (const { name } of (await kv.list({ prefix: PY_PENDING_PREFIX })).keys) {
    const pending = readPending(await kv.get(name));
    if (pending === undefined || (await isStored(state, pending.psf))) {
      if (pending === undefined) state.result.errors.push(`${name}: unreadable pending record, dropped`);
      await kv.delete(name);
      continue;
    }
    await settle(state, pending.psf, pending.doc);
  }
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const cfg = readConfig(ctx.source.config);
  const kv = ctx.env.CURSORS;
  const state: RunState = { ctx, cfg, result: { fetched: 0, upserted: 0, unchanged: 0, errors: [] }, deferred: 0 };
  const [cursor, etag] = await Promise.all([kv.get(PY_CURSOR_KEY), kv.get(PY_ETAG_KEY)]);
  // HTTP and D1 errors throw out of the run; the cursor holds the last handled id.
  const listing = await fetchListing(ctx.fetch, cfg.listing_url, ctx.env.GITHUB_TOKEN, etag ?? undefined);
  await recheckPending(state);
  let capped = false;
  if (!listing.notModified) {
    const ids = newIds(parsePsfListing(listing.body), cursor, ctx.now(), cfg.backfill_days);
    capped = ids.length > cfg.max_records;
    for (const id of ids.slice(0, cfg.max_records)) {
      await handleNew(state, id);
      await kv.put(PY_CURSOR_KEY, id);
    }
    // The ETag is kept only when this run handled every new id, so a 304 never hides unread records.
    if (capped || listing.etag === undefined) await kv.delete(PY_ETAG_KEY);
    else await kv.put(PY_ETAG_KEY, listing.etag);
  }
  if (state.deferred > 0) state.result.deferred = state.deferred;
  if (capped || state.deferred > 0) state.result.incomplete = true;
  return state.result;
}

export const pythonRuntime: Ingester = { id: SOURCE, run };
