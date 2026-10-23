# Retention

One section per table. A new table that grows ships its own rule and its scheduled job in the same PR.

## advisories

Kept forever. This table is the product's history, and the feed cursor (`since=`) depends on every row staying in place. No delete job.

## advisory_sources

Kept forever. One row per `(source, source_id)`, with the same life as its advisory. No delete job.

## advisory_cves

Kept forever. One row per `(cve, advisory_id)`: every CVE id of an advisory, written by the upsert. Rows live and die with their advisory, and advisories are kept forever, so no row is ever orphaned. No delete job.

## sources

A fixed set of rows (10 today: `osv`, `nvd`, `kev`, `epss`, `node-runtime`, `node-eol`, `php-runtime`, `python-runtime`, `deno-runtime`, `bun-runtime`). It does not grow. `last_error` is overwritten on each run, never appended, so the row does not grow either. `last_warning` (TCS-50) is one value, overwritten by the next run that has a warning and kept by a run with none, cut to 1,000 chars. `coverage_since` (TCS-32) is one value per row, written once when the source has read its whole history (for `osv`: when every enabled ecosystem has a done `backfill` row) and never moved after that. No delete job.

## backfill

The OSV backfill progress (TCS-32): one row per OSV ecosystem, keyed by `ecosystem`, written by `POST /v1/internal/import`. A rerun updates the row in place (`imported`, `unchanged`, `skipped`, `last_id`, `done_at`, `coverage_since`), so the table has at most one row per enabled ecosystem (6 today) and does not grow with traffic or with reruns. The row is the resume point of the import and the source of `/v1/check` coverage for the ecosystem, so it is kept for as long as the ecosystem is enabled. No delete job. To import an ecosystem again from the start, an operator runs the workflow again after its `done_at` is set: the first batch resets the counters and keeps `done_at`.

## KV `cursor:deno-runtime`, `cursor:bun-runtime` (CURSORS namespace)

One key per source: the newest GitHub `published_at` the source has read. Overwritten in place after a complete run, never moved back. No TTL and no delete job; the key count does not grow. An operator deletes the key (and the `:etag` key below) to make the source read every advisory again; the upserts are idempotent.

## KV `deno-runtime:etag`, `bun-runtime:etag` (CURSORS namespace)

One key per source: the ETag of the first advisories page, sent as `If-None-Match` on the next run. Overwritten in place after a complete run, deleted when the page had no ETag. No TTL and no delete job; the key count does not grow.

## settings

A small key/value table of run-time limits and knobs (today eleven rows: `feed.anon_rate_per_minute`, `check.anon_rate_per_minute`, `check.max_body_bytes`, `site.latest_rows`, `site.latest_cache_seconds`, `keys.anon_rate_per_minute`, `auth.last_used_resolution_seconds`, `watchlists.max_body_bytes`, `retention.api_key_unused_days`, `retention.api_keys_batch`, `retention.api_keys_dry_run`). Rows change in place by key; the table does not grow with traffic. No delete job.

## api_keys

One row per email (TCS-8). It grows with sign-ups. Auth moves `last_used_at` forward at most once per `auth.last_used_resolution_seconds` (default 86400). A monthly cron (`17 3 1 * *`, `src/cron/retention.ts`) deletes every key whose `last_used_at` is older than `retention.api_key_unused_days` (default 365), and that key's watch lists, in one transaction. One run deletes at most `retention.api_keys_batch` keys (default 5000), oldest first; the rest wait for the next run. When `retention.api_keys_dry_run` is not `0`, the run counts what it would delete and deletes nothing. A key is not money or history, so it is deleted, not archived.

## watchlists

One row per watch list, at most `plans.max_watchlists` per key. A row is deleted by `DELETE /v1/watchlists/{id}`, or by the monthly `api_keys` job together with its key. Its `cursor` is overwritten in place, so a row does not grow.

## plans

A fixed set of plan rows (one today: `free`). It does not grow. No delete job.

## KV `retention:api_keys:last` (CURSORS namespace)

One key: the audit record of the last `api_keys` retention run, `{ran_at, cutoff, dry_run, keys, watchlists, has_more}`. It is written after the delete commits, never after a failed run, and each run overwrites it. Each run also writes the same record as one log line. No delete job.

## KV `rl:` keys (CURSORS namespace)

The rate-limit counters, one key per client IP per minute: `rl:v1:<ip>:<minute>` for `/v1/events`, `rl:v1:check:<ip>:<minute>` for `/v1/check` and `rl:v1:keys:<ip>:<minute>` for `POST /v1/keys`. Each key is written with a 120-second TTL, so KV expires it on its own. No delete job.

## KV `nvd:queried:` keys (CURSORS namespace)

`nvd:queried:<cve>` marks a CVE that NVD answered with no score (or a 404), so the NVD ingester does not ask again. Each key is written with a TTL of `requery_hours` (config of the `nvd` sources row, default 24 hours), so KV expires it on its own and the CVE is asked again after that. A CVE that gets a score leaves the candidate query instead. No delete job.

## KV `cursor:nvd` and `epss:state` (CURSORS namespace)

One key each, overwritten in place. `cursor:nvd` is the NVD scan position (the last CVE examined, or empty to start over). `epss:state` is `{score_date, after}`, the progress of the EPSS pass for one EPSS score date. They do not grow. No delete job.

## KV `site:latest` key (CURSORS namespace)

The key is `site:latest:v2` since TCS-35 (value `{ rows, freshness }`). The old `site:latest:v1` array key gets no new writes and expires by its TTL.

One key: the landing page's Latest rows and freshness line as JSON. It is written with a TTL from the settings row `site.latest_cache_seconds` (default 60, never below 60), so KV expires it on its own. Losing it costs one D1 read. No delete job.

## python_runtime_records

The python-runtime ingest ledger. It has one row per PSF advisory id (`PSF-YYYY-N`), with the outcome (`ok`, `empty`, `pending`, `failed`), the attempt count and the next check time. Rows are kept forever, the same as `advisories`. If a row is deleted, the ingester reads that PSF record and its CVE record again. The PSF advisory database sets the limit on the row count: 195 records on 2026-10-22, with a few dozen new records each year. No delete job.

## KV `python:listing-etag` (CURSORS namespace)

One key: the ETag of the last full PSF listing. Each run overwrites it in place. No delete job.

## KV `python:tags` (CURSORS namespace)

One key: `{etag, versions}` from the last full read of the CPython `v3.` tag refs, so a 304 answer can reuse the released set. Each full read overwrites it in place, and its size follows the number of CPython 3.x tags (471 on 2026-10-22). No delete job.

## KV `node-dist-index` (CURSORS namespace)

One key: `{etag, fetched_at, versions}` from the last read of the nodejs.org dist index (TCS-30). A run uses it as is while it is younger than `dist_cache_seconds` (config of the `node-runtime` sources row, default 3600). After that the run sends one conditional GET, and a 304 only moves `fetched_at`. It has no KV TTL, so the ETag outlives the window. Each read overwrites it in place, and its size follows the number of Node.js releases. Losing it costs one download. No delete job.

## KV `cursor:node-runtime:parser` (CURSORS namespace)

One key: the parser revision (`"2"` since TCS-30) that the `cursor:node-runtime` cursor was read with. A run that finds another value moves the cursor back to the backfill window once and writes the revision. It does not grow. No delete job.
