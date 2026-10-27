-- TCS-106: auto-post critical runtime advisories to the Tocsin X account
-- (@tocsinagent). Additive only: new tables, indexes and seed rows.
-- Retention: docs/RETENTION.md.

-- One row per (advisory, channel): the dedup and spend ledger of the social
-- lane (src/cron/social.ts). The row is written `pending` before any X call
-- and claimed `sending` (attempts + 1) just before the call, so a second tick
-- never calls X for the same advisory.
CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY,
  advisory_id TEXT NOT NULL,
  channel TEXT NOT NULL,           -- 'x'
  status TEXT NOT NULL,            -- pending | sending | ok | empty | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,           -- due time while pending; lease end while sending
  first_attempt_at TEXT,           -- the daily cap counts rows by this time
  posted_id TEXT,                  -- the X post id, only for ok
  posted_at TEXT,
  error TEXT,                      -- at most 200 chars; never a header or a token
  text TEXT NOT NULL,              -- the exact text sent
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Dedup: the lookup by (advisory_id, channel) and the insert's ON CONFLICT target.
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_posts_advisory_channel ON social_posts (advisory_id, channel);
-- The claim (status = 'pending' AND next_at <= now ORDER BY next_at) and the stale-lease sweep (status = 'sending').
CREATE INDEX IF NOT EXISTS idx_social_posts_due ON social_posts (channel, status, next_at);
-- The daily cap count: first_attempt_at >= the start of the UTC day.
CREATE INDEX IF NOT EXISTS idx_social_posts_attempted ON social_posts (channel, first_attempt_at);
-- GET /v1/status posted_24h: status = 'ok' AND posted_at >= now - 24 h.
CREATE INDEX IF NOT EXISTS idx_social_posts_posted ON social_posts (channel, status, posted_at);
-- The daily retention select (src/cron/social-retention.ts).
CREATE INDEX IF NOT EXISTS idx_social_posts_retention ON social_posts (created_at);

-- Terminal social_posts rows older than social.retention_days, moved here by
-- the daily retention job. History: kept forever (at most social.x.daily_cap rows a day).
CREATE TABLE IF NOT EXISTS social_posts_archive (
  id INTEGER PRIMARY KEY,
  advisory_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_at TEXT NOT NULL,
  first_attempt_at TEXT,
  posted_id TEXT,
  posted_at TEXT,
  error TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
-- The archive upsert's ON CONFLICT target, the delete's EXISTS probe and the replay lookup.
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_posts_archive_advisory_channel ON social_posts_archive (advisory_id, channel);

-- The social lane's watermark: the last advisory cursor it read and the time
-- of that scan (first sight is an advisory id minted after it).
INSERT OR IGNORE INTO match_cursors (lane, cursor, updated_at)
  SELECT 'social:x', COALESCE(MAX(cursor), 0), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM advisories;

-- Status channel of the social lane, never an ingester: each enabled run
-- overwrites last_run_at and last_error in place. enabled 0 keeps it off the
-- ingest cron, the status sources list and /v1/check coverage (like 'mail').
INSERT OR IGNORE INTO sources (id, kind, enabled) VALUES ('social-x', 'social', 0);

-- 1 posts; any other value posts nothing. Off until the operator flips it (docs/OPERATING.md).
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.enabled', '0');
-- Lowest severity label that posts: critical | high | medium | low. An unknown value acts as critical.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.min_severity', 'critical');
-- Sources that post, comma-separated. osv-go-toolchain = OSV Go rows on the Go toolchain (stdlib, toolchain, cmd/*).
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.sources', 'node-runtime,php-runtime,python-runtime,deno-runtime,bun-runtime,osv-go-toolchain');
-- X calls per UTC day (first attempts). Over the cap, rows wait as pending for the next day.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.daily_cap', '10');
-- An advisory published longer ago than this many hours never posts (backfill and first-enable guard).
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.max_age_hours', '72');
-- Candidate advisories read per ecosystem per tick.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.scan_rows', '200');
-- Attempts for a 429 or 5xx answer before the row is terminal failed.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.max_attempts', '3');
-- Seconds before the next attempt after a 429 or 5xx.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.retry_seconds', '600');
-- A sending row older than this many seconds is terminal failed (unknown_outcome), never sent again.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.lease_seconds', '300');
-- Fetch timeout of one X call, in ms.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.timeout_ms', '10000');
-- X weighted length limit of one post.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.max_chars', '280');
-- X weight of one URL (t.co).
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.url_chars', '23');
-- The summary is cut to no fewer than this many chars before the fixed-version list is shortened.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.x.min_summary_chars', '60');
-- Daily retention: terminal social_posts rows older than this many days move to social_posts_archive.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.retention_days', '365');
-- Daily retention: most rows archived in one run.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.retention_batch', '5000');
-- Daily retention: 0 archives; any other value counts and moves nothing.
INSERT OR IGNORE INTO settings (key, value) VALUES ('social.retention_dry_run', '0');
