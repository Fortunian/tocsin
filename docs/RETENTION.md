# Retention

One section per table. A new table that grows ships its own rule and its scheduled job in the same PR.

## advisories

Kept forever. This table is the product's history, and the feed cursor (`since=`) depends on every row staying in place. No delete job.

## advisory_sources

Kept forever. One row per `(source, source_id)`, with the same life as its advisory. No delete job.

## advisory_cves

Kept forever. One row per `(cve, advisory_id)`: every CVE id of an advisory, written by the upsert. Rows live and die with their advisory, and advisories are kept forever, so no row is ever orphaned. No delete job.

## sources

A fixed set of rows (6 today: `osv`, `nvd`, `kev`, `epss`, `node-runtime`, `php-runtime`). It does not grow. `last_error` is overwritten on each run, never appended, so the row does not grow either. No delete job.

## settings

A small key/value table of run-time limits and knobs (today five rows: `feed.anon_rate_per_minute`, `check.anon_rate_per_minute`, `check.max_body_bytes`, `site.latest_rows`, `site.latest_cache_seconds`). Rows change in place by key; the table does not grow with traffic. No delete job.

## KV `rl:` keys (CURSORS namespace)

The rate-limit counters, one key per client IP per minute: `rl:v1:<ip>:<minute>` for `/v1/events` and `rl:v1:check:<ip>:<minute>` for `/v1/check`. Each key is written with a 120-second TTL, so KV expires it on its own. No delete job.

## KV `nvd:queried:` keys (CURSORS namespace)

`nvd:queried:<cve>` marks a CVE that NVD answered with no score (or a 404), so the NVD ingester does not ask again. Each key is written with a TTL of `requery_hours` (config of the `nvd` sources row, default 24 hours), so KV expires it on its own and the CVE is asked again after that. A CVE that gets a score leaves the candidate query instead. No delete job.

## KV `cursor:nvd` and `epss:state` (CURSORS namespace)

One key each, overwritten in place. `cursor:nvd` is the NVD scan position (the last CVE examined, or empty to start over). `epss:state` is `{score_date, after}`, the progress of the EPSS pass for one EPSS score date. They do not grow. No delete job.

## KV `site:latest:v1` key (CURSORS namespace)

One key: the landing page's Latest rows as JSON. It is written with a TTL from the settings row `site.latest_cache_seconds` (default 60, never below 60), so KV expires it on its own. Losing it costs one D1 read. No delete job.
