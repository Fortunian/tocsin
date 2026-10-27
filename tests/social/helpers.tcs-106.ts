import { env } from "cloudflare:workers";
import type { AdvisoryInput } from "../../src/ingest/types";
import { upsertAdvisory } from "../../src/ingest/upsert";
import type { SeverityLabel } from "../../src/schema/advisory";
import { FAKE_X_BODY_KEY, FAKE_X_CALLS_KEY, FAKE_X_MODE_KEY, readFakeXCalls, type FakeXMode } from "../../src/social/fake";

// Seed and state helpers for the TCS-106 suites. Every advisory has a unique
// source_id and summary, so assertions filter by the ids a test made. Each
// test calls resetSocial() first: it clears social_posts, moves the social
// watermark to the newest cursor one second in the past and sets the knobs
// the suites rely on, so no test depends on the order of the others.

export function uid(tag: string): string {
  return `${tag}-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export interface SeedOpts {
  ecosystem?: string;
  component?: string;
  source?: string;
  severity?: SeverityLabel;
  publishedAt?: string;
  fixed?: string[];
  summary?: string;
}

export interface Seeded {
  id: string;
  cursor: number;
  sourceId: string;
  input: AdvisoryInput;
}

// Writes one advisory through the production upsert (D4: the stored doc has
// the shape the ingesters write).
export async function seedAdvisory(o: SeedOpts = {}): Promise<Seeded> {
  const source = o.source ?? "node-runtime";
  const sourceId = uid(`src-${source}`);
  const ecosystem = o.ecosystem ?? "node";
  const component = o.component ?? ecosystem;
  const fixed = o.fixed ?? ["22.23.4", "24.22.1"];
  const published = o.publishedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const input: AdvisoryInput = {
    cve_ids: [],
    ecosystem,
    component,
    affected: fixed.map((f) => ({ introduced: `${f.split(".")[0]}.0.0`, fixed: f })),
    fixed_versions: fixed,
    severity: { label: o.severity ?? "critical" },
    exploited: false,
    published_at: published,
    modified_at: published,
    summary: o.summary ?? `Fixture flaw ${sourceId}`,
    action: `Upgrade ${component}.`,
    references: [`https://example.test/${sourceId}`],
    sources: [{ source, source_id: sourceId, url: `https://example.test/${sourceId}` }],
  };
  await upsertAdvisory(env.DB, input, { source, source_id: sourceId });
  const row = await env.DB.prepare(
    "SELECT a.id, a.cursor FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = ? AND s.source_id = ?",
  )
    .bind(source, sourceId)
    .first<{ id: string; cursor: number }>();
  if (!row) throw new Error(`seed failed for ${sourceId}`);
  return { id: row.id, cursor: row.cursor, sourceId, input };
}

// Re-writes a seeded advisory through the same source key: a new cursor, the same id.
export async function updateAdvisory(s: Seeded, change: Partial<AdvisoryInput>): Promise<number> {
  const source = s.input.sources[0].source;
  await upsertAdvisory(env.DB, { ...s.input, ...change, modified_at: new Date(Date.now() + 1000).toISOString().replace(/\.\d{3}Z$/, "Z") }, { source, source_id: s.sourceId });
  const row = await env.DB.prepare("SELECT cursor FROM advisories WHERE id = ?").bind(s.id).first<{ cursor: number }>();
  return row!.cursor;
}

export async function setKnob(key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

export const DEFAULT_KNOBS: Record<string, string> = {
  "social.x.enabled": "1",
  "social.x.min_severity": "critical",
  "social.x.sources": "node-runtime,php-runtime,python-runtime,deno-runtime,bun-runtime,osv-go-toolchain",
  "social.x.daily_cap": "10",
  "social.x.max_age_hours": "72",
  "social.x.scan_rows": "200",
  "social.x.max_attempts": "3",
  "social.x.retry_seconds": "0",
  "social.x.lease_seconds": "300",
};

export async function resetSocial(knobs: Record<string, string> = {}): Promise<void> {
  await env.DB.prepare("DELETE FROM social_posts").run();
  await env.DB.prepare(
    "UPDATE match_cursors SET cursor = (SELECT COALESCE(MAX(cursor), 0) FROM advisories), updated_at = ?1 WHERE lane = 'social:x'",
  )
    .bind(new Date(Date.now() - 1000).toISOString())
    .run();
  await env.DB.prepare("UPDATE sources SET last_run_at = NULL, last_ok_at = NULL, last_error = NULL WHERE id = 'social-x'").run();
  for (const [k, v] of Object.entries({ ...DEFAULT_KNOBS, ...knobs })) await setKnob(k, v);
  await Promise.all([env.CURSORS.delete(FAKE_X_CALLS_KEY), env.CURSORS.delete(FAKE_X_MODE_KEY), env.CURSORS.delete(FAKE_X_BODY_KEY)]);
}

export async function fakeMode(mode: FakeXMode, body?: string): Promise<void> {
  await env.CURSORS.put(FAKE_X_MODE_KEY, mode);
  if (body !== undefined) await env.CURSORS.put(FAKE_X_BODY_KEY, body);
}

// Fake X calls whose text links the advisory.
export async function callsFor(advisoryId: string): Promise<string[]> {
  return (await readFakeXCalls(env.CURSORS)).map((c) => c.text).filter((t) => t.includes(advisoryId));
}

export interface PostRow {
  status: string;
  attempts: number;
  posted_id: string | null;
  posted_at: string | null;
  error: string | null;
  text: string;
  next_at: string;
  first_attempt_at: string | null;
  updated_at: string;
}

export async function postsFor(advisoryId: string): Promise<PostRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT status, attempts, posted_id, posted_at, error, text, next_at, first_attempt_at, updated_at FROM social_posts WHERE advisory_id = ? AND channel = 'x'",
  )
    .bind(advisoryId)
    .all<PostRow>();
  return results;
}
