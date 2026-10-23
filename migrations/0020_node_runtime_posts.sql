-- TCS-69: the node-runtime post ledger. One row per post URL of the nodejs.org
-- vulnerability feed with its outcome, so a post that has nothing to emit has a
-- terminal state: ok and empty are not read again (except the newest feed post),
-- pending waits for its next_check_at, failed retries until the attempt cap and
-- is then terminal (next_check_at NULL). It replaces the KV keys
-- cursor:node-runtime and cursor:node-runtime:parser.
-- Retention: kept forever, bounded by the feed (docs/RETENTION.md). Additive only.
CREATE TABLE IF NOT EXISTS node_runtime_posts (
  url TEXT PRIMARY KEY,
  published TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok', 'empty', 'pending', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  parser_rev TEXT NOT NULL,
  next_check_at TEXT,
  updated_at TEXT NOT NULL
);

-- The due-work reads: WHERE state = ? AND next_check_at <= ?, the retrying
-- read (state = 'failed' AND next_check_at IS NOT NULL) and the grouped status count.
CREATE INDEX IF NOT EXISTS idx_node_runtime_posts_state_next ON node_runtime_posts (state, next_check_at);

-- The recheck knobs (src/ingest/node-runtime.ts NODE_DEFAULTS). json_set only
-- when pending_recheck_minutes is not set, so an edited value is never overwritten.
UPDATE sources
SET config_json = json_set(config_json, '$.pending_recheck_minutes', 60, '$.pending_old_recheck_minutes', 10080, '$.max_attempts', 10)
WHERE id = 'node-runtime' AND json_extract(config_json, '$.pending_recheck_minutes') IS NULL;
