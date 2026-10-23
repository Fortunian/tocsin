-- TCS-39: the python-runtime ingest ledger. One row per PSF advisory id with
-- its outcome, so every metered read has a persisted state: ok and empty are
-- terminal, pending waits for a python.org release, failed retries up to the
-- attempt cap and is then terminal (next_check_at NULL).
-- Retention: kept forever, bounded by the PSF record count (docs/RETENTION.md).
-- Additive only.
CREATE TABLE IF NOT EXISTS python_runtime_records (
  psf_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('ok', 'empty', 'pending', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  cve TEXT,
  unreleased TEXT,
  next_check_at TEXT,
  updated_at TEXT NOT NULL
);

-- The due-work reads: WHERE state = ? AND next_check_at <= ?, and the
-- terminal-failed read: WHERE state = 'failed' AND next_check_at IS NULL.
CREATE INDEX IF NOT EXISTS idx_python_runtime_records_state_next ON python_runtime_records (state, next_check_at);
