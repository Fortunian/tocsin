-- TCS-32: the one-time OSV backfill. Additive only. Retention: docs/RETENTION.md.
-- One row per OSV ecosystem, written by POST /v1/internal/import
-- (src/routes/internal-import.ts). `last_id` is the resume watermark of the
-- import script; `done_at` is set by the final batch; `coverage_since` is the
-- oldest published_at the import has written for the ecosystem.
-- Indexes: every read and write is by the primary key `ecosystem`
-- (sqlite_autoindex_backfill_1), or a full read of a table with one row per
-- enabled ecosystem (6 today). No secondary index is needed
-- (tests/routes/backfill-plan.tcs-32.test.ts).
CREATE TABLE IF NOT EXISTS backfill (
  ecosystem TEXT PRIMARY KEY,
  started_at TEXT,
  done_at TEXT,
  imported INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  last_id TEXT,
  coverage_since TEXT
);

-- The oldest published_at a source holds. NULL until its history is read in full.
ALTER TABLE sources ADD COLUMN coverage_since TEXT;

-- Import limits (CLAUDE.md rule 5). INSERT OR IGNORE never overwrites an edited value.
-- Records per POST /v1/internal/import request. About 5 D1 queries per new record
-- against the limit of 1,000 D1 queries per Worker invocation (src/routes/internal-import.ts).
INSERT OR IGNORE INTO settings (key, value) VALUES ('import.max_batch', '100');
-- Body cap of one import request in bytes (8 MB).
INSERT OR IGNORE INTO settings (key, value) VALUES ('import.max_body_bytes', '8388608');
