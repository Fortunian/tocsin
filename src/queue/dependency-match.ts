// The dependency match pass (TCS-37). After each ingest run it reads the
// advisories above the match lane cursor, matches each one against the stored
// dependency sets of webhook lists with the /v1/check matcher, inserts one
// deliveries row per (watchlist_id, advisory_id) with the affected items, and
// sends one queue message per new pending row. The rows commit BEFORE the
// send; a lost send leaves the row pending and sweepDeliveries sends it.
import { CHUNK_SIZE, lookupName } from "../check/candidates";
import { goRuntimeView, isGoToolchainAdvisory, GO_RUNTIME } from "../check/go-runtime";
import { matchAdvisory } from "../check/match";
import { affectedItem, type AffectedItem } from "../check/run";
import type { Env } from "../env";
import { getSettingInt } from "../lib/settings";
import type { Advisory } from "../schema/advisory";
import {
  DEPENDENCY_DELIVERY_INSERT_SQL,
  DEPENDENCY_DOCS_SQL,
  DEPENDENCY_MATCH_SQL,
  DEPENDENCY_WINDOW_SQL,
  FALLBACK_DEPENDENCY_INSERT_CHUNK,
  FALLBACK_DEPENDENCY_SCAN_ROWS,
  MATCH_ADVANCE_SQL,
  MATCH_CURSOR_SQL,
  filterAccepts,
} from "../watchlists/dependencies";
import type { WatchlistFilter } from "../watchlists/filter";
import { FALLBACK_MAX_EVENT_AGE_DAYS, QUEUE_SEND_BATCH_MAX, type DeliveryMessage } from "./enqueue";

export interface DependencyMatchResult {
  advisories: number;
  pairs: number;
  inserted: number;
  skipped: number;
  sent: number;
  send_errors: number;
  // 1 when another writer (an upload rewind or a second pass) wrote the lane
  // during this pass; the pass writes no row and leaves the lane where that
  // writer put it.
  cas_lost: number;
}

interface WindowRow {
  id: string;
  cursor: number;
  ecosystem: string;
  component: string;
  severity_label: string;
  exploited: number;
  published_at: string | null;
  exploited_at: string | null;
}

interface DepRow {
  watchlist_id: string;
  ecosystem: string;
  name: string;
  dep_ecosystem: string;
  dep_name: string;
  version: string;
  filter_json: string;
  dependencies_cursor: number;
  dependencies_at: string | null;
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const keyOf = (ecosystem: string, name: string) => `${ecosystem}\u0000${name}`;

// The lookup keys of one advisory: its own [ecosystem, name], plus the `go`
// runtime key for a Go toolchain advisory (TCS-40). Stored advisories hold the
// base ecosystem already.
function advisoryKeys(a: Pick<WindowRow, "ecosystem" | "component">): Array<[string, string]> {
  const keys: Array<[string, string]> = [[a.ecosystem, lookupName(a.ecosystem, a.component)]];
  if (isGoToolchainAdvisory(a)) keys.push([GO_RUNTIME, GO_RUNTIME]);
  return keys;
}

// The same COALESCE rule as the filter enqueue (src/queue/enqueue.ts): an
// advisory published and flagged exploited before the cutoff is history.
function isAged(a: WindowRow, cutoff: string): boolean {
  if (a.published_at === null) return false;
  return a.published_at < cutoff && (a.exploited_at === null || a.exploited_at < cutoff);
}

export async function enqueueDependencyMatches(env: Env, now: Date): Promise<DependencyMatchResult> {
  const res: DependencyMatchResult = { advisories: 0, pairs: 0, inserted: 0, skipped: 0, sent: 0, send_errors: 0, cas_lost: 0 };
  const [scanRows, insertChunkRaw, maxAgeDays, lane] = await Promise.all([
    getSettingInt(env.DB, "webhooks.dependency_scan_rows", FALLBACK_DEPENDENCY_SCAN_ROWS),
    getSettingInt(env.DB, "webhooks.dependency_insert_chunk", FALLBACK_DEPENDENCY_INSERT_CHUNK),
    getSettingInt(env.DB, "webhooks.max_event_age_days", FALLBACK_MAX_EVENT_AGE_DAYS),
    env.DB.prepare(MATCH_CURSOR_SQL).first<{ cursor: number; version: number }>(),
  ]);
  if (scanRows < 1) {
    console.error(JSON.stringify({ lane: "depmatch", err: `knob out of range: dependency_scan_rows=${scanRows}` }));
    return res;
  }
  const insertChunk = insertChunkRaw > 0 ? insertChunkRaw : FALLBACK_DEPENDENCY_INSERT_CHUNK;
  if (!lane) {
    // Slow, never wrong: each list's dependencies_cursor still bounds what it gets.
    console.error(JSON.stringify({ lane: "depmatch", err: "match_cursors row 'dependencies' missing, reading from 0" }));
  }
  const g0 = lane?.cursor ?? 0;
  const v0 = lane?.version ?? 0;

  const { results: window } = await env.DB.prepare(DEPENDENCY_WINDOW_SQL).bind(g0, scanRows).all<WindowRow>();
  if (window.length === 0) return res;
  res.advisories = window.length;
  const g1 = window[window.length - 1].cursor;

  // The stored dependencies under every key of the window, in one batch.
  const keys = new Map<string, [string, string]>();
  for (const a of window) for (const k of advisoryKeys(a)) keys.set(keyOf(...k), k);
  const keyList = [...keys.values()];
  const reads: D1PreparedStatement[] = [];
  for (let i = 0; i < keyList.length; i += CHUNK_SIZE) reads.push(env.DB.prepare(DEPENDENCY_MATCH_SQL).bind(JSON.stringify(keyList.slice(i, i + CHUNK_SIZE))));
  const depsByKey = new Map<string, DepRow[]>();
  for (const r of await env.DB.batch<DepRow>(reads)) {
    for (const d of r.results) {
      const k = keyOf(d.ecosystem, d.name);
      const list = depsByKey.get(k);
      if (list) list.push(d);
      else depsByKey.set(k, [d]);
    }
  }

  // Candidate pairs: a list with a dependency under one of the advisory's
  // keys, and the advisory above the list's upload check cursor.
  const pairs = new Map<string, { a: WindowRow; listId: string; deps: DepRow[] }>();
  for (const a of window) {
    for (const k of advisoryKeys(a)) {
      for (const d of depsByKey.get(keyOf(...k)) ?? []) {
        if (a.cursor <= d.dependencies_cursor) continue;
        const pk = `${d.watchlist_id}\u0000${a.id}`;
        const p = pairs.get(pk);
        if (p) p.deps.push(d);
        else pairs.set(pk, { a, listId: d.watchlist_id, deps: [d] });
      }
    }
  }
  res.pairs = pairs.size;

  const items: Array<[string, string, number, string, string]> = [];
  if (pairs.size > 0) {
    const ids = [...new Set([...pairs.values()].map((p) => p.a.id))];
    const docReads: D1PreparedStatement[] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) docReads.push(env.DB.prepare(DEPENDENCY_DOCS_SQL).bind(JSON.stringify(ids.slice(i, i + CHUNK_SIZE))));
    const docs = new Map<string, Advisory>();
    for (const r of await env.DB.batch<{ id: string; doc_json: string }>(docReads)) {
      for (const row of r.results) docs.set(row.id, JSON.parse(row.doc_json) as Advisory);
    }
    const filters = new Map<string, WatchlistFilter>();
    for (const { a, listId, deps } of pairs.values()) {
      const doc = docs.get(a.id);
      if (!doc) continue;
      const affected: AffectedItem[] = [];
      for (const d of deps) {
        const dep = { ecosystem: d.dep_ecosystem, name: d.dep_name, version: d.version };
        // A `go` runtime dependency reads a toolchain advisory through its runtime view.
        const view = d.ecosystem === GO_RUNTIME && isGoToolchainAdvisory(doc) ? goRuntimeView(doc) : doc;
        const r = matchAdvisory(dep, view);
        if (r.affected) affected.push(affectedItem(dep, view, r));
      }
      if (affected.length === 0) continue;
      let filter = filters.get(listId);
      if (!filter) {
        filter = JSON.parse(deps[0].filter_json) as WatchlistFilter;
        filters.set(listId, filter);
      }
      if (!filterAccepts(filter, a)) continue;
      const anchor = Date.parse(deps[0].dependencies_at ?? "");
      const cutoff = new Date((Number.isNaN(anchor) ? now.getTime() : anchor) - maxAgeDays * 86_400_000).toISOString();
      items.push([listId, a.id, a.cursor, isAged(a, cutoff) ? "skipped" : "pending", JSON.stringify(affected)]);
    }
  }

  // One transaction: the new rows, then the lane compare-and-set. Both are
  // void when an upload (or another pass) wrote the lane after the read above.
  const nowIso = now.toISOString();
  const writes: D1PreparedStatement[] = [];
  for (let i = 0; i < items.length; i += insertChunk) writes.push(env.DB.prepare(DEPENDENCY_DELIVERY_INSERT_SQL).bind(JSON.stringify(items.slice(i, i + insertChunk)), nowIso, g0, v0));
  writes.push(env.DB.prepare(MATCH_ADVANCE_SQL).bind(g1, nowIso, g0, v0));
  const written = await env.DB.batch<{ watchlist_id: string; advisory_id: string; status: string }>(writes);
  if ((written[written.length - 1].meta.changes ?? 0) === 0) res.cas_lost = 1;
  const fresh: DeliveryMessage[] = [];
  for (const w of written.slice(0, -1)) {
    for (const r of w.results) {
      res.inserted += 1;
      if (r.status === "skipped") res.skipped += 1;
      else fresh.push({ watchlist_id: r.watchlist_id, advisory_id: r.advisory_id });
    }
  }

  // Cloudflare Queues takes at most 100 messages per sendBatch call. A failed
  // chunk leaves its rows pending; the sweep sends them.
  for (let i = 0; i < fresh.length; i += QUEUE_SEND_BATCH_MAX) {
    const chunk = fresh.slice(i, i + QUEUE_SEND_BATCH_MAX);
    try {
      await env.DELIVERIES.sendBatch(chunk.map((body) => ({ body })));
      res.sent += chunk.length;
    } catch (err) {
      res.send_errors += 1;
      console.error(JSON.stringify({ lane: "depmatch", rows: chunk.length, err: `send failed, the sweep re-sends: ${errText(err)}` }));
    }
  }
  console.log(JSON.stringify({ lane: "depmatch", ...res }));
  return res;
}
