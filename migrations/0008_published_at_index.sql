-- The landing page's Latest table reads the newest advisories by publish date
-- (src/site/data.ts LATEST_SQL): ORDER BY published_at DESC, cursor DESC LIMIT n.
-- Feed order (cursor) is ingest order, which puts a re-touched old advisory
-- ahead of a fresh one. This index serves that ORDER BY without a scan.
CREATE INDEX IF NOT EXISTS idx_advisories_published_at ON advisories (published_at, cursor);
