// The mail send caps of POST /v1/keys as one atomic reserve in D1 (TCS-83).
// Three windows: one per client IP per hour, one per email per hour, one per
// UTC day. A send runs only after all three rows moved by 1 in one D1 batch
// (one transaction), so two parallel requests never read the same count.

export interface SendWindows {
  ip: string;
  email: string;
  day: string;
}

export interface SendCaps {
  ip: number;
  email: number;
  day: number;
}

export type ReserveResult = { reserved: true } | { reserved: false; ipOrEmailFull: boolean; dayFull: boolean; daySent: number };

// ?1 ip key, ?2 email key, ?3 day key, ?4 now ISO. Primary key conflict target.
export const RESERVE_INSERT_SQL =
  "INSERT INTO send_counters (window_key, n, created_at) VALUES (?1, 0, ?4), (?2, 0, ?4), (?3, 0, ?4) ON CONFLICT(window_key) DO NOTHING";
// ?1..?3 as above, ?5 ip cap, ?6 email cap, ?7 day cap. All three rows move,
// or none: the uncorrelated count of full rows is taken once, before the update.
export const RESERVE_UPDATE_SQL = `WITH over AS MATERIALIZED (
  SELECT COUNT(*) AS c FROM send_counters
  WHERE (window_key = ?1 AND n >= ?5) OR (window_key = ?2 AND n >= ?6) OR (window_key = ?3 AND n >= ?7))
UPDATE send_counters SET n = n + 1
WHERE window_key IN (?1, ?2, ?3) AND (SELECT c FROM over) = 0
RETURNING window_key, n`;
export const SNAPSHOT_SQL = "SELECT window_key, n FROM send_counters WHERE window_key IN (?1, ?2, ?3)";
export const REFUND_SQL = "UPDATE send_counters SET n = n - 1 WHERE window_key IN (?1, ?2, ?3) AND n > 0";

function logError(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ lane: "mail", ...fields }));
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// Takes one slot in each of the three windows, or none. A cap of 0 refuses
// every send. The refusal says which cap is full, from the counts the same
// transaction saw.
export async function reserveSend(db: D1Database, w: SendWindows, caps: SendCaps, nowIso: string): Promise<ReserveResult> {
  const [, upd, snap] = await db.batch<{ window_key: string; n: number }>([
    db.prepare(RESERVE_INSERT_SQL).bind(w.ip, w.email, w.day, nowIso),
    db.prepare(RESERVE_UPDATE_SQL).bind(w.ip, w.email, w.day, nowIso, caps.ip, caps.email, caps.day),
    db.prepare(SNAPSHOT_SQL).bind(w.ip, w.email, w.day),
  ]);
  const moved = upd.results.length;
  if (moved === 3) return { reserved: true };
  if (moved > 0) {
    // Not reachable by design: the update moves all three rows or none.
    logError({ err: "partial reserve", moved });
    await refundSend(db, w);
  }
  const n = new Map(snap.results.map((r) => [r.window_key, r.n]));
  const at = (key: string) => n.get(key) ?? 0;
  return { reserved: false, ipOrEmailFull: at(w.ip) >= caps.ip || at(w.email) >= caps.email, dayFull: at(w.day) >= caps.day, daySent: at(w.day) };
}

// Gives the three slots back after a send that did not go out. A fault is
// logged, not raised: the count stays, an over-count on the safe side of a cap.
export async function refundSend(db: D1Database, w: SendWindows): Promise<void> {
  try {
    await db.prepare(REFUND_SQL).bind(w.ip, w.email, w.day).run();
  } catch (err) {
    logError({ err: errText(err), step: "refund" });
  }
}
