-- TCS-32: Node history. Additive only. Retention: docs/RETENTION.md.
-- The node-runtime source reads every post of the vulnerability feed once, 20
-- posts per run, back to 4000 days. An incomplete post older than 365 days is
-- reported and passed (retry_incomplete_days). json_set only when max_posts is
-- not set, so an edited value is never overwritten.
UPDATE sources
SET config_json = json_set(config_json, '$.max_posts', 20, '$.backfill_days', 4000, '$.retry_incomplete_days', 365)
WHERE id = 'node-runtime' AND json_extract(config_json, '$.max_posts') IS NULL;

-- The node-eol source: one advisory per Node.js release line past its end of
-- life (src/ingest/node-eol.ts). config_json '{}' uses the code fallbacks
-- (NODE_EOL_DEFAULTS). INSERT OR IGNORE never edits an existing row.
INSERT OR IGNORE INTO sources (id, kind, enabled, config_json) VALUES ('node-eol', 'node-eol', 1, '{}');
