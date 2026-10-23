// Source id -> its per-record ledger table. GET /v1/status and /status read one
// grouped count per table. The table name comes from this map only, never from
// a request or a DB value, because it goes into SQL text.
export const LEDGER_TABLES: Record<string, string> = {
  "python-runtime": "python_runtime_records",
  "node-runtime": "node_runtime_posts",
};

export interface LedgerCounts {
  ok: number;
  empty: number;
  pending: number;
  failed_retrying: number;
  failed_terminal: number;
}

export interface LedgerRow {
  state: string;
  n: number;
  no_next: number;
}

// At most 4 rows (the state CHECK). Each ledger table has an index on
// (state, next_check_at) that covers this read.
export function ledgerSql(table: string): string {
  return `SELECT state, COUNT(*) AS n, SUM(next_check_at IS NULL) AS no_next FROM ${table} GROUP BY state`;
}

// A failed row with no next_check_at is terminal; with one, it retries.
// A state with no rows is 0: the grouped read ran and found none.
export function toLedgerCounts(rows: LedgerRow[]): LedgerCounts {
  const counts: LedgerCounts = { ok: 0, empty: 0, pending: 0, failed_retrying: 0, failed_terminal: 0 };
  for (const r of rows) {
    if (r.state === "ok" || r.state === "empty" || r.state === "pending") counts[r.state] = r.n;
    else if (r.state === "failed") {
      counts.failed_terminal = r.no_next;
      counts.failed_retrying = r.n - r.no_next;
    }
  }
  return counts;
}
