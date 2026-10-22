-- NVD enrichment candidates (src/ingest/nvd.ts): WHERE severity_score IS NULL
-- AND cve_primary IS NOT NULL AND cve_primary > ? ORDER BY cve_primary.
-- Additive only: one partial index, no new table, no retention rule needed.
CREATE INDEX IF NOT EXISTS idx_advisories_nvd_pending ON advisories (cve_primary)
  WHERE severity_score IS NULL AND cve_primary IS NOT NULL;
