// The node-runtime post ledger: table node_runtime_posts (migrations/0020).
// One row per post URL. ok and empty are terminal (the newest feed post in
// state ok or empty is read again, because Node edits a post in place);
// pending waits for next_check_at; failed retries until next_check_at is
// NULL, and is then terminal. A post that reaches max_attempts is empty.

export type PostState = "ok" | "empty" | "pending" | "failed";

export interface PostRow {
  url: string;
  published: string;
  state: PostState;
  attempts: number;
  parser_rev: string;
  next_check_at: string | null;
  // NULL on a row written before the column was filled (a seeded test row).
  title: string | null;
}

const COLS = "url, published, state, attempts, parser_rev, next_check_at, title";
const MAX_ERROR_CHARS = 500;

export const POST_SQL = {
  // Primary-key seeks for every listed URL, one JSON parameter (D1 allows 100 bound parameters).
  known: `SELECT ${COLS} FROM node_runtime_posts WHERE url IN (SELECT value FROM json_each(?))`,
  // idx_node_runtime_posts_state_next.
  due: `SELECT ${COLS} FROM node_runtime_posts WHERE state = ? AND next_check_at <= ? ORDER BY next_check_at LIMIT ?`,
  // idx_node_runtime_posts_state_next (state IN): a recent post (published >= ?)
  // the parser did not read in full holds coverage_since back: a failed row, an
  // empty row with a note (an attempt cap), or an ok row with CVE headings not
  // emitted. An empty row with no note (no CVE headings in an old post) does not.
  unread:
    "SELECT 1 AS r FROM node_runtime_posts WHERE state IN ('failed', 'empty', 'ok') AND published >= ? " +
    "AND (state = 'failed' OR (state = 'empty' AND last_error IS NOT NULL) OR (state = 'ok' AND unemitted > 0)) LIMIT 1",
  write:
    "INSERT INTO node_runtime_posts (url, published, state, attempts, last_error, parser_rev, next_check_at, updated_at, title, unemitted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(url) DO UPDATE SET published = excluded.published, state = excluded.state, attempts = excluded.attempts, last_error = excluded.last_error, " +
    "parser_rev = excluded.parser_rev, next_check_at = excluded.next_check_at, updated_at = excluded.updated_at, title = COALESCE(excluded.title, title), unemitted = excluded.unemitted",
} as const;

export interface PostWrite {
  url: string;
  published: string;
  state: PostState;
  attempts: number;
  parser_rev: string;
  // Empty or absent keeps the stored title.
  title?: string;
  // CVE headings of the read that gave no advisory. Absent is 0: every read sets it.
  unemitted?: number;
  last_error?: string;
  next_check_at?: string;
}

export interface Ledger {
  known: Map<string, PostRow>;
  due: PostRow[];
}

// The known rows of the given URLs and the due pending and failed rows
// (at most `limit` of each), in one batch: 1 round trip, 3 statements.
export async function readLedger(db: D1Database, urls: string[], now: Date, limit: number): Promise<Ledger> {
  const at = now.toISOString();
  const [known, pending, failed] = await db.batch<PostRow>([
    db.prepare(POST_SQL.known).bind(JSON.stringify(urls)),
    db.prepare(POST_SQL.due).bind("pending", at, limit),
    db.prepare(POST_SQL.due).bind("failed", at, limit),
  ]);
  return { known: new Map(known.results.map((r) => [r.url, r])), due: [...pending.results, ...failed.results] };
}

// True when a post published at or after `sinceIso` holds coverage_since back (POST_SQL.unread).
export async function hasUnreadRecent(db: D1Database, sinceIso: string): Promise<boolean> {
  return (await db.prepare(POST_SQL.unread).bind(sinceIso).first<{ r: number }>()) !== null;
}

export async function writePost(db: D1Database, w: PostWrite, now: Date): Promise<void> {
  await db
    .prepare(POST_SQL.write)
    .bind(
      w.url,
      w.published,
      w.state,
      w.attempts,
      w.last_error === undefined ? null : w.last_error.slice(0, MAX_ERROR_CHARS),
      w.parser_rev,
      w.next_check_at ?? null,
      now.toISOString(),
      w.title === undefined || w.title === "" ? null : w.title,
      w.unemitted ?? 0,
    )
    .run();
}
