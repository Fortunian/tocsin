// The OSV backfill write path (TCS-32). scripts/backfill/run.mjs reads an
// OSV all.zip in GitHub Actions and posts the records here in batches. Each
// record goes through the cron's own normalizeOsv and upsertAdvisory, so the
// import is idempotent on (source, source_id). The backfill row is written
// last in a request, so last_id never passes a record that was not written.
import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../env";
import { keepStoredKeys, normalizeOsv, NOT_ENABLED_REASON, OSV_CONFIG_SQL, readConfig, type OsvVuln } from "../ingest/osv";
import type { AdvisoryInput } from "../ingest/types";
import { InvalidAdvisoryError, upsertAdvisory } from "../ingest/upsert";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";

// Code fallbacks only. The live values are the settings rows import.max_batch
// and import.max_body_bytes (migrations/0014_backfill.sql).
// One new record costs about 5 D1 queries (findByPair, findByCve, insert,
// insertSource, insertCve). A Worker invocation may run 1,000 D1 queries
// (paid plan), so 100 records (about 500 queries) leave room for a record
// with more than one doc or CVE.
export const FALLBACK_MAX_BATCH = 100;
export const FALLBACK_MAX_BODY_BYTES = 8 * 1024 * 1024;

const NO_STORE = { "Cache-Control": "no-store" };

// PK seek on backfill (sqlite_autoindex_backfill_1).
export const BACKFILL_GET_SQL =
  "SELECT ecosystem, started_at, done_at, imported, unchanged, skipped, last_id, coverage_since FROM backfill WHERE ecosystem = ?";
// ?1 ecosystem, ?2 now, ?3 imported, ?4 unchanged, ?5 skipped, ?6 last_id,
// ?7 final (0/1), ?8 oldest published_at of the batch, ?9 start (0/1).
// SQLite evaluates every SET term on the stored row, so the terms do not see each other.
// start = 1 opens a new run: the counters, last_id and started_at reset; done_at and
// coverage_since stay, so a re-run never makes a done ecosystem partial.
// A batch whose last_id is not past the stored one is a replay: its upserts
// ran (idempotent), but it adds nothing to the counters.
export const BACKFILL_UPSERT_SQL = `INSERT INTO backfill (ecosystem, started_at, done_at, imported, unchanged, skipped, last_id, coverage_since)
VALUES (?1, ?2, CASE WHEN ?7 = 1 THEN ?2 END, ?3, ?4, ?5, ?6, ?8)
ON CONFLICT(ecosystem) DO UPDATE SET
  imported = CASE WHEN ?9 = 1 THEN excluded.imported WHEN backfill.last_id IS NULL OR excluded.last_id > backfill.last_id THEN backfill.imported + excluded.imported ELSE backfill.imported END,
  unchanged = CASE WHEN ?9 = 1 THEN excluded.unchanged WHEN backfill.last_id IS NULL OR excluded.last_id > backfill.last_id THEN backfill.unchanged + excluded.unchanged ELSE backfill.unchanged END,
  skipped = CASE WHEN ?9 = 1 THEN excluded.skipped WHEN backfill.last_id IS NULL OR excluded.last_id > backfill.last_id THEN backfill.skipped + excluded.skipped ELSE backfill.skipped END,
  started_at = CASE WHEN ?9 = 1 OR backfill.started_at IS NULL THEN excluded.started_at ELSE backfill.started_at END,
  last_id = CASE WHEN ?9 = 1 OR backfill.last_id IS NULL OR excluded.last_id > backfill.last_id THEN excluded.last_id ELSE backfill.last_id END,
  done_at = CASE WHEN ?7 = 1 THEN COALESCE(backfill.done_at, excluded.started_at) ELSE backfill.done_at END,
  coverage_since = CASE WHEN backfill.coverage_since IS NULL THEN excluded.coverage_since WHEN excluded.coverage_since IS NULL THEN backfill.coverage_since ELSE MIN(backfill.coverage_since, excluded.coverage_since) END
RETURNING ecosystem, started_at, done_at, imported, unchanged, skipped, last_id, coverage_since`;
// ?1 the OSV source_ids of one request as a JSON array. One read for the batch:
// the stored modified_at and creator of each (osv, source_id) that exists
// (PK seek on advisory_sources, then PK of advisories).
export const STORED_MODIFIED_SQL = `SELECT s.source_id, a.modified_at, json_extract(a.doc_json, '$.sources[0].source') AS creator_source, json_extract(a.doc_json, '$.sources[0].source_id') AS creator_id
FROM json_each(?1) j CROSS JOIN advisory_sources s ON s.source = 'osv' AND s.source_id = j.value JOIN advisories a ON a.id = s.advisory_id`;
// ?1 the enabled ecosystems as a JSON array. sources.osv.coverage_since moves
// only when every one of them has a done backfill row.
// Both subqueries drive from the JSON list and seek backfill by its primary key
// (CROSS JOIN keeps json_each as the outer loop in SQLite).
export const OSV_COVERAGE_SQL = `UPDATE sources SET coverage_since = (SELECT MIN(b.coverage_since) FROM json_each(?1) j CROSS JOIN backfill b ON b.ecosystem = j.value)
WHERE id = 'osv' AND (SELECT COUNT(*) FROM json_each(?1) j CROSS JOIN backfill b ON b.ecosystem = j.value WHERE b.done_at IS NOT NULL) = json_array_length(?1)`;

interface BackfillRow {
  ecosystem: string;
  started_at: string | null;
  done_at: string | null;
  imported: number;
  unchanged: number;
  skipped: number;
  last_id: string | null;
  coverage_since: string | null;
}

interface ImportBody {
  ecosystem: string;
  records: unknown[];
  skipped: number;
  last_id: string;
  final: boolean;
  start: boolean;
}

type Ctx = Context<{ Bindings: Env }>;

const answer = (c: Ctx, body: unknown, status: 200 | 400 | 401 | 403 | 413 = 200) => jsonUtf8(c, body, status, NO_STORE);

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

// Bearer IMPORT_TOKEN. No header: 401. No secret, or a token that does not
// match: 403 (fail closed). Both sides are trimmed (a secret pasted with a
// newline) and compared in constant time on their SHA-256.
async function auth(c: Ctx, next: Next) {
  const header = c.req.header("Authorization");
  if (header === undefined || !/^Bearer(\s|$)/i.test(header)) return answer(c, { error: "missing bearer token" }, 401);
  const secret = (c.env.IMPORT_TOKEN ?? "").trim();
  const given = header.replace(/^Bearer/i, "").trim();
  if (secret === "" || given === "") return answer(c, { error: "forbidden" }, 403);
  const [a, b] = await Promise.all([sha256(secret), sha256(given)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) return answer(c, { error: "forbidden" }, 403);
  await next();
}

async function osvConfig(db: D1Database) {
  const row = await db.prepare(OSV_CONFIG_SQL).first<{ config_json: string }>();
  return readConfig(row ? (JSON.parse(row.config_json) as Record<string, unknown>) : {});
}

function zeroRow(ecosystem: string): BackfillRow {
  return { ecosystem, started_at: null, done_at: null, imported: 0, unchanged: 0, skipped: 0, last_id: null, coverage_since: null };
}

function parseBody(raw: unknown): ImportBody | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "body must be a JSON object";
  const b = raw as Record<string, unknown>;
  if (typeof b.ecosystem !== "string" || b.ecosystem === "") return "ecosystem must be a non-empty string";
  if (!Array.isArray(b.records)) return "records must be an array of OSV records";
  if (typeof b.skipped !== "number" || !Number.isInteger(b.skipped) || b.skipped < 0) return "skipped must be a non-negative integer";
  if (typeof b.last_id !== "string" || b.last_id === "") return "last_id must be a non-empty string";
  if (b.final !== undefined && typeof b.final !== "boolean") return "final must be a boolean";
  if (b.start !== undefined && typeof b.start !== "boolean") return "start must be a boolean";
  return { ecosystem: b.ecosystem, records: b.records, skipped: b.skipped, last_id: b.last_id, final: b.final === true, start: b.start === true };
}

const internalImport = new Hono<{ Bindings: Env }>();

internalImport.use("*", auth);

internalImport.get("/:ecosystem", async (c) => {
  const ecosystem = c.req.param("ecosystem");
  const [cfg, maxBatch] = await Promise.all([osvConfig(c.env.DB), getSettingInt(c.env.DB, "import.max_batch", FALLBACK_MAX_BATCH)]);
  if (!cfg.ecosystems.includes(ecosystem)) return answer(c, { error: `ecosystem ${ecosystem} is not enabled in the osv source config`, enabled: cfg.ecosystems }, 400);
  const row = (await c.env.DB.prepare(BACKFILL_GET_SQL).bind(ecosystem).first<BackfillRow>()) ?? zeroRow(ecosystem);
  return answer(c, { ...row, max_batch: maxBatch, skip_id_prefixes: cfg.skip_id_prefixes });
});

internalImport.post(
  "/",
  async (c, next) => {
    const maxSize = await getSettingInt(c.env.DB, "import.max_body_bytes", FALLBACK_MAX_BODY_BYTES);
    return bodyLimit({ maxSize, onError: (c) => answer(c, { error: `body over ${maxSize} bytes` }, 413) })(c, next);
  },
  async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return answer(c, { error: "invalid JSON" }, 400);
    }
    const body = parseBody(raw);
    if (typeof body === "string") return answer(c, { error: body }, 400);
    const db = c.env.DB;
    const [cfg, maxBatch] = await Promise.all([osvConfig(db), getSettingInt(db, "import.max_batch", FALLBACK_MAX_BATCH)]);
    if (!cfg.ecosystems.includes(body.ecosystem)) {
      return answer(c, { error: `ecosystem ${body.ecosystem} is not enabled in the osv source config`, enabled: cfg.ecosystems }, 400);
    }
    if (body.records.length > maxBatch) return answer(c, { error: `more than ${maxBatch} records in one request (settings import.max_batch)` }, 413);

    // Counts per record (imported: at least one doc written; unchanged: every
    // doc unchanged or stale) and per doc (inserted, updated, stale). A record
    // with no package in an enabled ecosystem is skipped (ecosystem_not_enabled).
    // Any other record that does not normalize is an error and is counted in neither.
    let imported = 0;
    let unchanged = 0;
    let skipped = body.skipped;
    let notEnabled = 0;
    let inserted = 0;
    let updated = 0;
    let stale = 0;
    let oldest: string | null = null;
    const errors: string[] = [];
    const normalized: { id: string; docs: { source_id: string; doc: AdvisoryInput }[] }[] = [];
    for (const item of body.records) {
      const v = item as OsvVuln;
      const id = typeof v?.id === "string" ? v.id : "?";
      if (cfg.skip_id_prefixes.some((p) => id.startsWith(p)) || (typeof v?.withdrawn === "string" && v.withdrawn !== "")) {
        skipped += 1;
        continue;
      }
      const norm = normalizeOsv(v, cfg.ecosystems);
      if (!norm.ok) {
        if (norm.reason === NOT_ENABLED_REASON) {
          skipped += 1;
          notEnabled += 1;
        } else {
          errors.push(`${id}: ${norm.reason}`);
        }
        continue;
      }
      normalized.push({ id, docs: norm.docs });
    }
    // A bare OSV id stays on the package stored under it (TCS-38). One read.
    await keepStoredKeys(db, normalized);

    // The zip is a snapshot, older than the OSV API the cron reads. A doc whose
    // stored copy was created by this same osv source_id and has a later
    // modified_at is not written: an older snapshot never replaces a newer
    // record. An equal modified_at still goes through upsertAdvisory (unchanged,
    // or a parser upgrade). One read for the whole request.
    const sourceIds = normalized.flatMap((r) => r.docs.map((d) => d.source_id));
    const storedModified = new Map<string, number>();
    if (sourceIds.length > 0) {
      const { results } = await db
        .prepare(STORED_MODIFIED_SQL)
        .bind(JSON.stringify(sourceIds))
        .all<{ source_id: string; modified_at: string; creator_source: string | null; creator_id: string | null }>();
      for (const r of results) {
        if (r.creator_source === "osv" && r.creator_id === r.source_id) storedModified.set(r.source_id, Date.parse(r.modified_at));
      }
    }

    for (const { docs } of normalized) {
      let wrote = false;
      let failed = false;
      for (const d of docs) {
        const stored = storedModified.get(d.source_id);
        if (stored !== undefined && stored > Date.parse(d.doc.modified_at)) {
          stale += 1;
        } else {
          try {
            // D1 errors throw out of the request (500): the backfill row is not moved.
            const outcome = await upsertAdvisory(db, d.doc, { source: "osv", source_id: d.source_id });
            if (outcome === "inserted") inserted += 1;
            if (outcome === "updated") updated += 1;
            if (outcome !== "unchanged") wrote = true;
          } catch (err) {
            if (!(err instanceof InvalidAdvisoryError)) throw err;
            errors.push(`${d.source_id}: ${err.message}`);
            failed = true;
            continue;
          }
        }
        // A stale doc is stored (in its newer copy), so it counts for coverage.
        if (d.doc.ecosystem === body.ecosystem && (oldest === null || d.doc.published_at < oldest)) oldest = d.doc.published_at;
      }
      if (wrote) imported += 1;
      else if (!failed) unchanged += 1;
    }

    const now = new Date().toISOString();
    const stmts = [
      db.prepare(BACKFILL_UPSERT_SQL).bind(body.ecosystem, now, imported, unchanged, skipped, body.last_id, body.final ? 1 : 0, oldest, body.start ? 1 : 0),
    ];
    if (body.final) stmts.push(db.prepare(OSV_COVERAGE_SQL).bind(JSON.stringify(cfg.ecosystems)));
    const [res] = await db.batch<BackfillRow>(stmts);
    const row = res.results[0];
    return answer(c, {
      ecosystem: body.ecosystem,
      imported,
      unchanged,
      skipped,
      skipped_reasons: { ecosystem_not_enabled: notEnabled },
      inserted,
      updated,
      stale,
      errors,
      last_id: row.last_id,
      done_at: row.done_at,
      row,
    });
  },
);

export default internalImport;
