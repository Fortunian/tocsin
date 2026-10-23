-- Every CVE id of every advisory, not only cve_primary (TCS-34): the page
-- /cve/<CVE> must find an advisory by its second CVE too. Additive only.
-- Retention: docs/RETENTION.md (rows live and die with their advisory).
CREATE TABLE IF NOT EXISTS advisory_cves (
  cve TEXT NOT NULL,
  advisory_id TEXT NOT NULL,
  PRIMARY KEY (cve, advisory_id)
);

-- The CVE page reads by the primary key (cve = ?). The sitemap joins one
-- chunk of advisories to their CVEs: WHERE advisory_id = ?.
CREATE INDEX IF NOT EXISTS idx_advisory_cves_advisory_id ON advisory_cves (advisory_id);

-- Backfill from the stored docs. Idempotent: a re-run adds no row.
INSERT OR IGNORE INTO advisory_cves (cve, advisory_id)
SELECT json_each.value, advisories.id FROM advisories, json_each(advisories.doc_json, '$.cve_ids');
