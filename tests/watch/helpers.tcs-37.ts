import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { runCron } from "../../src/cron/run";
import type { Env } from "../../src/env";
import type { Advisory, AffectedRange, SeverityLabel } from "../../src/schema/advisory";
import { validateAdvisory } from "../../src/schema/advisory";
import type { WatchlistFilter } from "../../src/watchlists/filter";
import nodeFixture from "../fixtures/advisory/valid.json";
import { FakeQueue, envWith, uid } from "../queue/helpers.tcs-11";

export { FakeQueue, uid };

// Seed helpers for the TCS-37 suites. Every key, list, plan and advisory id is
// unique (randomUUID), so tests never share rows. Advisory cursors are read
// from the table (MAX + 1), so a new advisory is always above every cursor a
// test or an upload has seen.

let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `2001:db8:37::${ipSeq.toString(16)}`;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A plan row with a dependency limit. maxDeps null: the column is NULL.
export async function seedPlan(maxDeps: number | null): Promise<string> {
  const id = uid("plan37");
  await env.DB.prepare("INSERT INTO plans (id, max_watchlists, webhooks, max_components, max_watch_dependencies) VALUES (?, 25, 1, 2000, ?)")
    .bind(id, maxDeps)
    .run();
  return id;
}

// An API key with a known token. The token has "fixture" in it on purpose.
export async function seedKey(plan = "free"): Promise<{ id: string; token: string }> {
  const id = uid("key37");
  const token = `tcs_fixture_${id}`;
  const ts = new Date().toISOString();
  await env.DB.prepare("INSERT INTO api_keys (id, key_hash, plan, email, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(token), plan, `${id}@example.test`, ts, ts)
    .run();
  return { id, token };
}

export async function seedList(keyId: string, o: { delivery?: "poll" | "webhook"; filter?: Partial<WatchlistFilter> } = {}): Promise<string> {
  const id = uid("wl37");
  const delivery = o.delivery ?? "webhook";
  const filter: WatchlistFilter = { ecosystems: [], components: [], runtimes: {}, min_severity: null, exploited_only: false, ...o.filter };
  await env.DB.prepare(
    `INSERT INTO watchlists (id, key_id, name, filter_json, cursor, delivery, webhook_url, webhook_secret, created_at)
     VALUES (?, ?, 'tcs37', ?, 0, ?, ?, ?, '2026-10-20T00:00:00.000Z')`,
  )
    .bind(id, keyId, JSON.stringify(filter), delivery, delivery === "webhook" ? `https://hooks.example.test/${id}` : null, delivery === "webhook" ? `whsec_fixture_${id}` : null)
    .run();
  return id;
}

export async function topCursor(): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(MAX(cursor), 0) AS c FROM advisories").first<{ c: number }>();
  return r?.c ?? 0;
}

export interface AdvSpec {
  ecosystem?: string;
  component: string;
  affected?: AffectedRange[];
  label?: SeverityLabel;
  publishedAt?: string;
  exploitedAt?: string | null;
}

export async function seedAdvisory(s: AdvSpec): Promise<{ id: string; cursor: number; doc_json: string }> {
  const id = "tcs_" + crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();
  const cursor = (await topCursor()) + 1;
  const doc = structuredClone(nodeFixture) as Advisory;
  const affected = s.affected ?? [{ introduced: "0", fixed: "4.17.21" }];
  doc.id = id;
  doc.ecosystem = s.ecosystem ?? "npm";
  doc.component = s.component;
  doc.affected = affected;
  doc.fixed_versions = affected.flatMap((r) => (r.fixed ? [r.fixed] : []));
  doc.severity = { score: 7, label: s.label ?? "high" };
  doc.cve_ids = [];
  doc.published_at = s.publishedAt ?? "2026-10-21T00:00:00Z";
  doc.action = `Upgrade ${s.component}.`;
  doc.sources = [{ source: "osv", source_id: id, url: `https://example.com/fixture/${id}` }];
  const v = validateAdvisory(doc);
  if (!v.ok) throw new Error(`seed doc invalid: ${v.errors.join("; ")}`);
  const doc_json = JSON.stringify(doc);
  await env.DB.prepare(
    `INSERT INTO advisories (id, cve_primary, ecosystem, component, severity_label, exploited, published_at, modified_at, doc_json, cursor, exploited_at)
     VALUES (?, NULL, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  )
    .bind(id, doc.ecosystem, doc.component, doc.severity.label, doc.published_at, doc.modified_at, doc_json, cursor, s.exploitedAt ?? null)
    .run();
  return { id, cursor, doc_json };
}

// A changed advisory: the ingesters give an update the next cursor (src/ingest/upsert.ts).
export async function recursor(advisoryId: string): Promise<number> {
  const cursor = (await topCursor()) + 1;
  await env.DB.prepare("UPDATE advisories SET cursor = ? WHERE id = ?").bind(cursor, advisoryId).run();
  return cursor;
}

// Drives the production entry point (src/index.ts default export).
export function call(method: string, path: string, o: { token?: string; json?: unknown; form?: FormData } = {}): Promise<Response> {
  const headers: Record<string, string> = { "CF-Connecting-IP": nextIp() };
  if (o.token !== undefined) headers.Authorization = `Bearer ${o.token}`;
  let body: BodyInit | undefined;
  if (o.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(o.json);
  } else if (o.form !== undefined) body = o.form;
  return exports.default.fetch(`https://tocsin.test${path}`, { method, headers, body });
}

export type Dep = { ecosystem: string; name: string; version: string };

export function upload(token: string, listId: string, dependencies: Dep[]): Promise<Response> {
  return call("POST", `/v1/watchlists/${listId}/lockfile`, { token, json: { dependencies } });
}

export async function storedDeps(listId: string): Promise<Array<{ dep_ecosystem: string; dep_name: string; version: string }>> {
  const { results } = await env.DB.prepare("SELECT dep_ecosystem, dep_name, version FROM watchlist_dependencies WHERE watchlist_id = ? ORDER BY dep_name, version")
    .bind(listId)
    .all<{ dep_ecosystem: string; dep_name: string; version: string }>();
  return results;
}

export async function depCount(listId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM watchlist_dependencies WHERE watchlist_id = ?").bind(listId).first<{ n: number }>();
  return r?.n ?? -1;
}

export interface DepDeliveryRow {
  watchlist_id: string;
  advisory_id: string;
  cursor: number;
  status: string;
  affected_json: string | null;
}

export async function deliveriesOf(listId: string): Promise<DepDeliveryRow[]> {
  const { results } = await env.DB.prepare("SELECT watchlist_id, advisory_id, cursor, status, affected_json FROM deliveries WHERE watchlist_id = ? ORDER BY cursor")
    .bind(listId)
    .all<DepDeliveryRow>();
  return results;
}

export async function matchCursor(): Promise<number> {
  const r = await env.DB.prepare("SELECT cursor FROM match_cursors WHERE lane = 'dependencies'").first<{ cursor: number }>();
  if (!r) throw new Error("no match_cursors row for lane dependencies");
  return r.cursor;
}

export async function setMatchCursor(c: number): Promise<void> {
  await env.DB.prepare("UPDATE match_cursors SET cursor = ? WHERE lane = 'dependencies'").bind(c).run();
}

// Other suites can seed advisories in the same D1 without a dependency pass.
// This puts the lane at the newest cursor, so the next pass reads only what a
// test seeds after this call (the window cap never hides it).
export async function alignMatchCursor(): Promise<void> {
  await setMatchCursor(await topCursor());
}

// One ingest cron run through runCron (src/cron/run.ts) with an empty ingest
// registry and a fake queue. 0 network calls.
export async function cron(queue: FakeQueue): Promise<void> {
  const ctx = createExecutionContext();
  const e: Env = envWith(queue);
  await runCron(createScheduledController({ cron: "*/10 * * * *", scheduledTime: Date.now() }), e, ctx, {});
  await waitOnExecutionContext(ctx);
}
