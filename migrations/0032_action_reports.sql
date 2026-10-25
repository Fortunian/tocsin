-- TCS-101: one row per GitHub Action run that reported its check result, for
-- the per-repo README badge GET /badge/<owner>/<repo>.svg. Written by
-- POST /v1/action/report (src/routes/action-report.ts) under a GitHub OIDC token.
CREATE TABLE IF NOT EXISTS action_reports (
  id INTEGER PRIMARY KEY,          -- arrival order; reported_at is server time, so id order = reported_at order
  owner TEXT NOT NULL,             -- lowercased, from the token claim `repository`
  repo TEXT NOT NULL,              -- lowercased, from the token claim `repository`
  ref TEXT NOT NULL,               -- token claim `ref`, for example refs/heads/main
  is_default INTEGER NOT NULL,     -- 1 when ref = 'refs/heads/' || the default branch the Action reported
  is_latest INTEGER NOT NULL,      -- 1 on the newest row per (owner, repo, ref); retention keeps it
  affected INTEGER NOT NULL,       -- affected dependencies at or above min_severity
  min_severity TEXT NOT NULL,      -- low | medium | high | critical
  run_id TEXT NOT NULL,            -- token claim `run_id`
  reported_at TEXT NOT NULL        -- ISO time the server received the report
);
-- Idempotency on run_id: the insert's ON CONFLICT target and the demote's NOT EXISTS probe.
CREATE UNIQUE INDEX IF NOT EXISTS ux_action_reports_run ON action_reports (owner, repo, run_id);
-- The ?ref= badge read (ORDER BY id DESC via the implicit rowid) and the demote UPDATE.
CREATE INDEX IF NOT EXISTS idx_action_reports_ref ON action_reports (owner, repo, ref);
-- The default-branch badge read (ORDER BY id DESC via the implicit rowid).
CREATE INDEX IF NOT EXISTS idx_action_reports_default ON action_reports (owner, repo, is_default);
-- The daily retention delete and its dry-run count (src/cron/action-reports-retention.ts).
CREATE INDEX IF NOT EXISTS idx_action_reports_retention ON action_reports (is_latest, reported_at);
-- Daily retention: non-latest action_reports rows older than this many days are deleted.
INSERT OR IGNORE INTO settings (key, value) VALUES ('badge.retention_days', '90');
-- Daily retention: most action_reports rows deleted in one run.
INSERT OR IGNORE INTO settings (key, value) VALUES ('badge.retention_batch', '5000');
-- Daily retention: 0 deletes; any other value counts and deletes nothing.
INSERT OR IGNORE INTO settings (key, value) VALUES ('badge.retention_dry_run', '0');
-- GET /badge/<owner>/<repo>.svg: edge cache and Cache-Control max-age, in seconds.
INSERT OR IGNORE INTO settings (key, value) VALUES ('badge.cache_seconds', '300');
-- POST /v1/action/report: KV TTL of the cached GitHub OIDC JWKS, in seconds.
INSERT OR IGNORE INTO settings (key, value) VALUES ('action.oidc_jwks_cache_seconds', '3600');
-- POST /v1/action/report: an unknown kid refetches the JWKS only when the cached copy is older than this, in seconds.
INSERT OR IGNORE INTO settings (key, value) VALUES ('action.oidc_jwks_refetch_seconds', '300');
-- POST /v1/action/report: clock skew allowed on the token's exp and nbf, in seconds.
INSERT OR IGNORE INTO settings (key, value) VALUES ('action.oidc_clock_skew_seconds', '60');
