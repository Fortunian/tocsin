// Idempotent advisory upsert keyed on advisory_sources (source, source_id),
// with cross-source merge by primary CVE. Every write bumps the feed cursor;
// an unchanged doc writes nothing.
import { validateAdvisory, type Advisory, type AdvisorySource } from "../schema/advisory";
import type { AdvisoryInput } from "./types";
import { newAdvisoryId } from "./ulid";

export type UpsertOutcome = "inserted" | "updated" | "unchanged";

export interface SourceKey {
  source: string;
  source_id: string;
}

export class InvalidAdvisoryError extends Error {
  constructor(readonly errors: string[]) {
    super(`invalid advisory: ${errors.join("; ")}`);
    this.name = "InvalidAdvisoryError";
  }
}

// The next feed cursor, as a subselect evaluated inside the writing statement
// (one index seek on idx_advisories_cursor).
const NEXT_CURSOR = "(SELECT COALESCE(MAX(cursor), 0) + 1 FROM advisories)";

export const UPSERT_SQL = {
  // PK of advisory_sources, then PK of advisories.
  findByPair:
    "SELECT s.advisory_id, a.doc_json FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = ? AND s.source_id = ?",
  // idx_advisories_cve_primary, then idx_advisory_sources_advisory_id for the rows of one CVE.
  findByCve:
    "SELECT a.id, a.doc_json FROM advisories a WHERE a.cve_primary = ? AND NOT EXISTS (SELECT 1 FROM advisory_sources s WHERE s.advisory_id = a.id AND s.source = ?) ORDER BY a.cursor LIMIT 1",
  nextCursor: NEXT_CURSOR,
  update: `UPDATE advisories SET cve_primary = ?, ecosystem = ?, component = ?, severity_label = ?, severity_score = ?, exploited = ?, epss = ?, published_at = ?, modified_at = ?, doc_json = ?, cursor = ${NEXT_CURSOR} WHERE id = ?`,
  insert: `INSERT INTO advisories (cve_primary, ecosystem, component, severity_label, severity_score, exploited, epss, published_at, modified_at, doc_json, id, cursor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_CURSOR})`,
  insertSource: "INSERT INTO advisory_sources (source, source_id, advisory_id) VALUES (?, ?, ?)",
  // One row per CVE id of the advisory (migration 0010). A merge only adds CVE ids.
  insertCve: "INSERT OR IGNORE INTO advisory_cves (cve, advisory_id) VALUES (?, ?)",
} as const;

function sortDeep(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortDeep);
  if (x !== null && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x).sort()) out[k] = sortDeep((x as Record<string, unknown>)[k]);
    return out;
  }
  return x;
}

// Recursive sorted keys, no whitespace. Undefined values are dropped, as in JSON.stringify.
export function canonicalJson(x: unknown): string {
  return JSON.stringify(sortDeep(x));
}

function union<T>(a: T[], b: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of [...a, ...b]) {
    const k = key(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

const sourceKey = (s: AdvisorySource) => `${s.source}\u0000${s.source_id}`;

// The doc's sources with `entry` appended, unless that (source, source_id) is
// already listed. An enrichment source never takes the creator slot sources[0].
export function appendSource(sources: AdvisorySource[], entry: AdvisorySource): AdvisorySource[] {
  return union(sources, [entry], sourceKey);
}

// The creator of an advisory (doc.sources[0]) owns its base fields; any other
// source only adds cve_ids, references and sources. exploited and epss are
// kept from the stored doc unless the incoming doc sets them, and a stored
// score (an NVD enrichment) is kept when the incoming doc has none.
function merge(stored: Advisory, incoming: AdvisoryInput, key: SourceKey): Advisory {
  const creator = stored.sources[0];
  const fromCreator = creator !== undefined && creator.source === key.source && creator.source_id === key.source_id;
  const { id: _id, ...storedBase } = stored;
  const base: AdvisoryInput = fromCreator ? incoming : storedBase;
  return {
    ...base,
    id: stored.id,
    cve_ids: union(stored.cve_ids, incoming.cve_ids, (c) => c).sort(),
    references: union(stored.references, incoming.references, (r) => r),
    sources: union(stored.sources, incoming.sources, sourceKey),
    severity: base.severity.score === undefined && stored.severity.score !== undefined ? stored.severity : base.severity,
    exploited: stored.exploited || incoming.exploited,
    epss: incoming.epss ?? stored.epss,
  };
}

export function checked(doc: Advisory): Advisory {
  const v = validateAdvisory(doc);
  if (!v.ok) throw new InvalidAdvisoryError(v.errors);
  return doc;
}

// Column values in the order of UPSERT_SQL.update / insert (without id and cursor).
function columns(doc: Advisory): unknown[] {
  return [
    doc.cve_ids[0] ?? null,
    doc.ecosystem,
    doc.component,
    doc.severity.label,
    doc.severity.score ?? null,
    doc.exploited ? 1 : 0,
    doc.epss ?? null,
    doc.published_at,
    doc.modified_at,
    canonicalJson(doc),
  ];
}

function cveRows(db: D1Database, doc: Advisory): D1PreparedStatement[] {
  return doc.cve_ids.map((cve) => db.prepare(UPSERT_SQL.insertCve).bind(cve, doc.id));
}

export async function upsertAdvisory(db: D1Database, doc: AdvisoryInput, key: SourceKey): Promise<UpsertOutcome> {
  const existing = await db
    .prepare(UPSERT_SQL.findByPair)
    .bind(key.source, key.source_id)
    .first<{ advisory_id: string; doc_json: string }>();

  if (existing) {
    const next = checked(merge(JSON.parse(existing.doc_json) as Advisory, doc, key));
    const json = canonicalJson(next);
    if (json === existing.doc_json) return "unchanged";
    await db.batch([db.prepare(UPSERT_SQL.update).bind(...columns(next), existing.advisory_id), ...cveRows(db, next)]);
    return "updated";
  }

  const cvePrimary = [...doc.cve_ids].sort()[0];
  if (cvePrimary !== undefined) {
    const match = await db
      .prepare(UPSERT_SQL.findByCve)
      .bind(cvePrimary, key.source)
      .first<{ id: string; doc_json: string }>();
    if (match) {
      const next = checked(merge(JSON.parse(match.doc_json) as Advisory, doc, key));
      await db.batch([
        db.prepare(UPSERT_SQL.update).bind(...columns(next), match.id),
        db.prepare(UPSERT_SQL.insertSource).bind(key.source, key.source_id, match.id),
        ...cveRows(db, next),
      ]);
      return "updated";
    }
  }

  const fresh = checked({
    ...doc,
    id: newAdvisoryId(new Date()),
    cve_ids: [...doc.cve_ids].sort(),
  });
  await db.batch([
    db.prepare(UPSERT_SQL.insert).bind(...columns(fresh), fresh.id),
    db.prepare(UPSERT_SQL.insertSource).bind(key.source, key.source_id, fresh.id),
    ...cveRows(db, fresh),
  ]);
  return "inserted";
}
