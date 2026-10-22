-- Tocsin initial schema. Additive only: never DROP or RENAME in a migration.
-- Retention for each table: docs/RETENTION.md.

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  last_ok_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS advisories (
  id TEXT PRIMARY KEY,
  cve_primary TEXT,
  ecosystem TEXT NOT NULL,
  component TEXT NOT NULL,
  severity_label TEXT NOT NULL DEFAULT 'unknown',
  severity_score REAL,
  exploited INTEGER NOT NULL DEFAULT 0,
  epss REAL,
  published_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  doc_json TEXT NOT NULL,
  cursor INTEGER UNIQUE
);

CREATE TABLE IF NOT EXISTS advisory_sources (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  advisory_id TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);

-- Feed: WHERE cursor > ? ORDER BY cursor.
CREATE INDEX IF NOT EXISTS idx_advisories_cursor ON advisories (cursor);
-- Feed filtered by ecosystem: WHERE ecosystem = ? AND cursor > ? ORDER BY cursor.
CREATE INDEX IF NOT EXISTS idx_advisories_ecosystem_cursor ON advisories (ecosystem, cursor);
-- Check: WHERE component = ? AND ecosystem = ?.
CREATE INDEX IF NOT EXISTS idx_advisories_component_ecosystem ON advisories (component, ecosystem);
-- Cross-source merge by CVE: WHERE cve_primary = ?.
CREATE INDEX IF NOT EXISTS idx_advisories_cve_primary ON advisories (cve_primary);
-- Sources of one advisory: WHERE advisory_id = ?.
CREATE INDEX IF NOT EXISTS idx_advisory_sources_advisory_id ON advisory_sources (advisory_id);
