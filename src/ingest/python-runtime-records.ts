// The python-runtime ingest ledger: table python_runtime_records
// (migrations/0011). One row per PSF id. ok and empty are terminal; pending
// waits for a python.org release; failed retries until the attempt cap and
// is then terminal (next_check_at NULL).
import type { AdvisoryInput } from "./types";

export type RecordState = "ok" | "empty" | "pending" | "failed";

export interface RecordRow {
  psf_id: string;
  state: RecordState;
  attempts: number;
  last_error: string | null;
  cve: string | null;
  unreleased: string | null;
  next_check_at: string | null;
}

// The `unreleased` column of a pending row: the full doc (every line) and
// the lines still waiting, each with the time it was first seen pending.
export interface PendingState {
  doc: AdvisoryInput;
  lines: { fixed: string; since: string }[];
  dropped: string[];
}

const COLS = "psf_id, state, attempts, last_error, cve, unreleased, next_check_at";
const MAX_ERROR_CHARS = 500;

export const RECORD_SQL = {
  // Primary-key seeks for every listed id, one JSON parameter (D1 allows 100 bound parameters).
  known: "SELECT psf_id FROM python_runtime_records WHERE psf_id IN (SELECT value FROM json_each(?))",
  // idx_python_runtime_records_state_next.
  due: `SELECT ${COLS} FROM python_runtime_records WHERE state = ? AND next_check_at <= ? ORDER BY next_check_at LIMIT ?`,
  terminalFailed: "SELECT psf_id FROM python_runtime_records WHERE state = 'failed' AND next_check_at IS NULL ORDER BY psf_id LIMIT 20",
  terminalFailedCount: "SELECT COUNT(*) AS n FROM python_runtime_records WHERE state = 'failed' AND next_check_at IS NULL",
  attempts: "SELECT attempts FROM python_runtime_records WHERE psf_id = ?",
  write:
    "INSERT INTO python_runtime_records (psf_id, state, attempts, last_error, cve, unreleased, next_check_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(psf_id) DO UPDATE SET state = excluded.state, attempts = excluded.attempts, last_error = excluded.last_error, " +
    "cve = COALESCE(excluded.cve, python_runtime_records.cve), unreleased = excluded.unreleased, next_check_at = excluded.next_check_at, updated_at = excluded.updated_at",
} as const;

export interface RecordWrite {
  psf_id: string;
  state: RecordState;
  attempts: number;
  last_error?: string;
  cve?: string;
  unreleased?: PendingState;
  next_check_at?: string;
}

export async function writeRecord(db: D1Database, w: RecordWrite, now: Date): Promise<void> {
  await db
    .prepare(RECORD_SQL.write)
    .bind(
      w.psf_id,
      w.state,
      w.attempts,
      w.last_error === undefined ? null : w.last_error.slice(0, MAX_ERROR_CHARS),
      w.cve ?? null,
      w.unreleased === undefined ? null : JSON.stringify(w.unreleased),
      w.next_check_at ?? null,
      now.toISOString(),
    )
    .run();
}

export async function knownIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { results } = await db.prepare(RECORD_SQL.known).bind(JSON.stringify(ids)).all<{ psf_id: string }>();
  return new Set(results.map((r) => r.psf_id));
}

export async function dueRows(db: D1Database, state: "pending" | "failed", now: Date, limit: number): Promise<RecordRow[]> {
  const { results } = await db.prepare(RECORD_SQL.due).bind(state, now.toISOString(), limit).all<RecordRow>();
  return results;
}

export async function attemptsOf(db: D1Database, psfId: string): Promise<number> {
  const row = await db.prepare(RECORD_SQL.attempts).bind(psfId).first<{ attempts: number }>();
  return row?.attempts ?? 0;
}

// "N records failed terminally: PSF-…", or undefined when there are none.
export async function terminalFailedNote(db: D1Database): Promise<string | undefined> {
  const [count, ids] = await db.batch<{ n?: number; psf_id?: string }>([db.prepare(RECORD_SQL.terminalFailedCount), db.prepare(RECORD_SQL.terminalFailed)]);
  const n = Number(count.results[0]?.n ?? 0);
  if (n === 0) return undefined;
  return `${n} records failed terminally: ${ids.results.map((r) => r.psf_id).join(", ")}`;
}

export function readPendingState(text: string | null): PendingState | undefined {
  if (text === null) return undefined;
  try {
    const p = JSON.parse(text) as PendingState;
    return p && typeof p.doc === "object" && Array.isArray(p.lines) && Array.isArray(p.dropped) ? p : undefined;
  } catch {
    return undefined;
  }
}
