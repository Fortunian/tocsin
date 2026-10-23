// The node-runtime post ledger: table node_runtime_posts (migrations/0020).
// One row per post URL. ok and empty are terminal (the newest feed post in
// state ok is read again, because Node edits a release post in place);
// pending waits for next_check_at; failed retries until next_check_at is
// NULL, and is then terminal.

export type PostState = "ok" | "empty" | "pending" | "failed";

export interface PostRow {
  url: string;
  published: string;
  state: PostState;
  attempts: number;
  parser_rev: string;
  next_check_at: string | null;
}

const COLS = "url, published, state, attempts, parser_rev, next_check_at";
const MAX_ERROR_CHARS = 500;

export const POST_SQL = {
  // Primary-key seeks for every listed URL, one JSON parameter (D1 allows 100 bound parameters).
  known: `SELECT ${COLS} FROM node_runtime_posts WHERE url IN (SELECT value FROM json_each(?))`,
  // idx_node_runtime_posts_state_next.
  due: `SELECT ${COLS} FROM node_runtime_posts WHERE state = ? AND next_check_at <= ? ORDER BY next_check_at LIMIT ?`,
  // idx_node_runtime_posts_state_next: a failed row that still retries.
  retrying: "SELECT 1 AS r FROM node_runtime_posts WHERE state = 'failed' AND next_check_at IS NOT NULL LIMIT 1",
  write:
    "INSERT INTO node_runtime_posts (url, published, state, attempts, last_error, parser_rev, next_check_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(url) DO UPDATE SET published = excluded.published, state = excluded.state, attempts = excluded.attempts, last_error = excluded.last_error, " +
    "parser_rev = excluded.parser_rev, next_check_at = excluded.next_check_at, updated_at = excluded.updated_at",
} as const;

export interface PostWrite {
  url: string;
  published: string;
  state: PostState;
  attempts: number;
  parser_rev: string;
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
    )
    .run();
}

export async function hasRetrying(db: D1Database): Promise<boolean> {
  return (await db.prepare(POST_SQL.retrying).first<{ r: number }>()) !== null;
}
