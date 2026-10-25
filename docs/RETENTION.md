# Retention

One section per table. A new table that grows ships its own rule and its scheduled job in the same PR.

## advisories

Kept forever. This table is the product's history, and the feed cursor (`since=`) depends on every row staying in place. No delete job.

## advisory_sources

Kept forever. One row per `(source, source_id)`, with the same life as its advisory. No delete job.

## advisory_cves

Kept forever. One row per `(cve, advisory_id)`: every CVE id of an advisory, written by the upsert. Rows live and die with their advisory, and advisories are kept forever, so no row is ever orphaned. No delete job.

## sources

A fixed set of rows (11 today: the 10 ingesters `osv`, `nvd`, `kev`, `epss`, `node-runtime`, `node-eol`, `php-runtime`, `python-runtime`, `deno-runtime`, `bun-runtime`, plus `mail`). `mail` (TCS-94, enabled 0) is the warning channel of the mail seam, not an ingester: an unsigned send overwrites its `last_warning` and `last_run_at` in place. It does not grow. `last_error` is overwritten on each run, never appended, so the row does not grow either. `last_warning` (TCS-50) is one value, overwritten by the next run that has a warning and kept by a run with none, cut to 1,000 chars. `coverage_since` (TCS-32) is one value per row, written once when the source has read its whole history (for `osv`: when every enabled ecosystem has a done `backfill` row) and never moved after that. No delete job.

## backfill

The OSV backfill progress (TCS-32): one row per OSV ecosystem, keyed by `ecosystem`, written by `POST /v1/internal/import`. A rerun updates the row in place (`imported`, `unchanged`, `skipped`, `last_id`, `done_at`, `coverage_since`), so the table has at most one row per enabled ecosystem (6 today) and does not grow with traffic or with reruns. The row is the resume point of the import and the source of `/v1/check` coverage for the ecosystem, so it is kept for as long as the ecosystem is enabled. No delete job. To import an ecosystem again from the start, an operator runs the workflow again after its `done_at` is set: the first batch resets the counters and keeps `done_at`.

## KV `cursor:deno-runtime`, `cursor:bun-runtime` (CURSORS namespace)

One key per source: the newest GitHub `published_at` the source has read. Overwritten in place after a complete run, never moved back. No TTL and no delete job; the key count does not grow. An operator deletes the key (and the `:etag` key below) to make the source read every advisory again; the upserts are idempotent.

## KV `deno-runtime:etag`, `bun-runtime:etag` (CURSORS namespace)

One key per source: the ETag of the first advisories page, sent as `If-None-Match` on the next run. Overwritten in place after a complete run, deleted when the page had no ETag. No TTL and no delete job; the key count does not grow.

## settings

A small key/value table of run-time limits and knobs (57 rows today; among them `feed.anon_rate_per_minute`, `site.latest_rows`, `site.latest_cache_seconds`, `import.max_batch`, `import.max_body_bytes`, `import.max_docs`, `check.anon_rate_per_minute`, `check.max_body_bytes`, `keys.anon_rate_per_minute`, `auth.last_used_resolution_seconds`, `watchlists.max_body_bytes`, `retention.api_key_unused_days`, `retention.api_keys_batch`, `retention.api_keys_dry_run`, `webhooks.backoff_seconds`, `webhooks.timeout_ms`, `webhooks.lease_seconds`, `webhooks.sweep_grace_seconds`, `webhooks.sweep_batch`, `webhooks.enqueue_max_lists`, `webhooks.enqueue_per_list`, `webhooks.max_event_age_days`, `webhooks.max_url_length`, `webhooks.deliveries_list_limit`, `retention.deliveries_days`, `retention.deliveries_batch`, `retention.deliveries_dry_run`, `webhooks.pause_after_failures`, `webhooks.dns_cache_seconds`, `webhooks.enqueue_scan_rows`, `webhooks.lag_alert_rows`, `webhooks.reencrypt_batch`, `webhooks.dependency_scan_rows`, `webhooks.dependency_insert_chunk`, `retention.send_counters_days`, `retention.send_counters_batch`, `retention.send_counters_dry_run`, `badge.retention_days`, `badge.retention_batch`, `badge.retention_dry_run`, `badge.cache_seconds`, `action.oidc_jwks_cache_seconds`, `action.oidc_jwks_refetch_seconds`, `action.oidc_clock_skew_seconds`). Rows change in place by key; the table does not grow with traffic. No delete job.

## api_keys

One row per email (TCS-8). It grows with sign-ups. Auth moves `last_used_at` forward at most once per `auth.last_used_resolution_seconds` (default 86400). A monthly cron (`17 3 1 * *`, `src/cron/retention.ts`) deletes every key whose `last_used_at` is older than `retention.api_key_unused_days` (default 365), and that key's watch lists, in one transaction. One run deletes at most `retention.api_keys_batch` keys (default 5000), oldest first; the rest wait for the next run. When `retention.api_keys_dry_run` is not `0`, the run counts what it would delete and deletes nothing. A key is not money or history, so it is deleted, not archived.

## watchlists

One row per watch list, at most `plans.max_watchlists` per key. A row is deleted by `DELETE /v1/watchlists/{id}`, or by the monthly `api_keys` job together with its key. Its `cursor` is overwritten in place (by `GET /v1/watchlists/{id}/events` and by webhook enqueue), so a row does not grow. The delivery health columns (`consecutive_failures`, `paused_at`, `last_delivery_at`, `last_delivery_code`, migration 0023) are overwritten in place by each webhook attempt and by `POST /v1/watchlists/{id}/resume`. `webhook_secret_enc` (migration 0026) holds the webhook secret encrypted with the Worker secret `WEBHOOK_KEK`; it is overwritten by each `PATCH` and goes with the row. When `WEBHOOK_KEK` is set, `webhook_secret` is NULL. `dependency_count`, `dependencies_cursor` and `dependencies_at` (migration 0028) are overwritten in place by each lockfile upload. A row written without the KEK keeps the plaintext in `webhook_secret` until the `*/10` cron job (`src/cron/reencrypt-secrets.ts`) moves it, at most `webhooks.reencrypt_batch` rows per run (default 500); the partial index `idx_watchlists_secret_plain` holds only rows still to move.

## watchlist_dependencies

The stored dependency set of a watch list (TCS-37), written by `POST /v1/watchlists/{id}/lockfile`. At most `plans.max_watch_dependencies` rows per list (2,000 on the free plan). Each upload deletes the list's rows and writes the new set in one transaction, so a list does not grow past its last upload. Rows are deleted with their list: `DELETE /v1/watchlists/{id}` deletes them in the same transaction as the list, and the monthly `api_keys` job deletes the rows of the lists it deletes in the same transaction. No other delete job. A row is a copy of a user's lockfile, not money or history, so it is deleted, not archived.

## match_cursors

One row per match lane (TCS-37): `dependencies`, the last advisory cursor the dependency match pass read, and a `version` that every pass advance and every lockfile upload increments. It is overwritten in place and does not grow. No delete job.

## deliveries

One row per (watch list, advisory) that webhook delivery found (TCS-11). The primary key `(watchlist_id, advisory_id)` is the exactly-once gate. It grows with every advisory a webhook list matches. A `delivered` row is that gate's record (CLAUDE.md rule 4): it is never deleted by age, so a backfill that moves an advisory to a new, higher cursor finds the row and sends nothing. A `failed` row is kept the same way (TCS-82): without it, that backfill would queue the pair again and POST it again. Delivered and failed rows live as long as their watch list. `DELETE /v1/watchlists/{id}` deletes the list's rows in the same transaction as the list, and the monthly key retention (`src/cron/retention.ts`) deletes the rows of the lists it deletes in the same transaction. A daily cron (`41 4 * * *`, `src/cron/deliveries-retention.ts`) deletes `skipped` rows whose `next_at` (the time of their last write) is older than `retention.deliveries_days` (default 90). A skipped row was never sent, so a new row for the same pair can never repeat a delivery. `pending` and `sending` rows are never deleted by the job: they end as `delivered` or `failed` within about 15 hours, or wait while their list is paused. One run deletes at most `retention.deliveries_batch` rows (default 5000), in one transaction; the rest wait for the next run. When `retention.deliveries_dry_run` is not `0`, the run counts what it would delete and deletes nothing. A row is a delivery receipt, not money or history, so it is deleted, not archived. `affected_json` (migration 0028) holds the affected items of a dependency list's row and goes with the row. The index `idx_deliveries_status_delivered_at` (0021) no longer serves a delete; it stays, because the schema is additive only.

## send_counters

The mail send caps of `POST /v1/keys` and `POST /v1/keys/rotate` (TCS-83). One row per window: `ip:<ip>:<hour>` (read against `keys.ip_sends_per_hour`), `em:<sha256 of the email>:<hour>` (`keys.email_sends_per_hour`) and `day:<YYYY-MM-DD>` (`mail.daily_send_cap`). `n` is the mails reserved in the window; a failed send gives its slot back. A row is only useful while its window is open, at most one UTC day. It grows with every caller of the key routes. A daily cron (`41 4 * * *`, `src/cron/send-counters-retention.ts`) deletes rows whose `created_at` is older than `retention.send_counters_days` (default 2), at most `retention.send_counters_batch` rows per run (default 5000); the rest wait for the next run. When `retention.send_counters_dry_run` is not `0`, the run counts what it would delete and deletes nothing. A row is a rate counter, not money or history, so it is deleted, not archived.

## KV `retention:send_counters:last` (CURSORS namespace)

One key: the audit record of the last `send_counters` retention run, `{ran_at, cutoff, dry_run, deleted, has_more}`. It is written after the delete commits, never after a failed run, and each run overwrites it. Each run also writes the same record as one log line. No delete job.

## action_reports

One row per GitHub Action run that reported its check result for the README badge (TCS-101, `POST /v1/action/report`). The unique index `(owner, repo, run_id)` is the idempotency gate: a second report of the same run adds no row. `is_latest` is 1 on the newest row of each `(owner, repo, ref)`; the badge reads it. The table grows with every reporting run, including pull request refs. A daily cron (`41 4 * * *`, `src/cron/action-reports-retention.ts`) deletes rows that are not the latest of their ref and were reported more than `badge.retention_days` ago (default 90). The latest row of each ref is never deleted, so a badge never goes back to `unknown` because of age. One run deletes at most `badge.retention_batch` rows (default 5000); the rest wait for the next run. When `badge.retention_dry_run` is not `0`, the run counts what it would delete and deletes nothing. A row is a CI status snapshot that the next run regenerates, not money or advisory history, so it is deleted, not archived.

## KV `retention:action_reports:last` (CURSORS namespace)

One key: the audit record of the last `action_reports` retention run, `{ran_at, cutoff, dry_run, deleted, has_more}`. It is written after the delete commits, never after a failed run, and each run overwrites it. Each run also writes the same record as one log line. No delete job.

## KV `oidc:github:jwks` (CURSORS namespace)

One key: `{fetched_at, keys}`, the GitHub Actions OIDC key set that `POST /v1/action/report` verifies tokens with (`src/lib/github-oidc.ts`). It has a KV TTL of `action.oidc_jwks_cache_seconds` (default 3600). An unknown key id fetches the set again at most once per `action.oidc_jwks_refetch_seconds` (default 300). Each fetch overwrites it in place. Losing it costs one fetch. No delete job.

## KV `webhooks:dns:<host>` (CURSORS namespace)

One key per webhook host: the A and AAAA answers of the send-time DNS over HTTPS check (TCS-11). Each key is written with a KV expiration of `webhooks.dns_cache_seconds` (default 60, at least 60), so KV deletes it; no delete job. With `webhooks.dns_cache_seconds` = `0` no key is written.

## KV `retention:deliveries:last` (CURSORS namespace)

One key: the audit record of the last `deliveries` retention run, `{ran_at, cutoff, dry_run, skipped, has_more}`. It is written after the delete commits, never after a failed run, and each run overwrites it. Each run also writes the same record as one log line. No delete job.

## KV `webhooks:enqueue:after` (CURSORS namespace)

One key: the last watch list id one enqueue run reached when it hit `webhooks.enqueue_max_lists`, or empty. The next run starts after it, so no list waits forever behind the cap. It is overwritten in place and does not grow. Losing it only restarts the rotation at the first list. No delete job.

## plans

A fixed set of plan rows (one today: `free`). It does not grow. No delete job.

## KV `retention:api_keys:last` (CURSORS namespace)

One key: the audit record of the last `api_keys` retention run, `{ran_at, cutoff, dry_run, keys, watchlists, has_more}`. It is written after the delete commits, never after a failed run, and each run overwrites it. Each run also writes the same record as one log line. No delete job.

## KV `rl:` keys (CURSORS namespace)

The rate-limit counters, one key per caller per minute: `rl:v1:<ip>:<minute>` for `/v1/events`, `rl:v1:check:<ip>:<minute>` for `/v1/check`, `rl:v1:keys:<ip>:<minute>` for `POST /v1/keys` and `rl:v1:key:<key_id>:<minute>` for the `/v1/watchlists` routes. Each key is written with a 120-second TTL, so KV expires it on its own. No delete job.

## KV `keyconfirm:v1:` keys (CURSORS namespace)

One key per mailed key link (TCS-64): `keyconfirm:v1:<sha256 of the token>`, value `{email, purpose, expect_hash, expires_at}`. Opening the link deletes it. An unopened link expires by its TTL, `keys.confirm_ttl_seconds` (default 3600, never below 60). No delete job.

## KV `mail:fake:` keys (CURSORS namespace)

Tests only. The test mailer (`src/mail/fake.ts`, selected by `MAIL_TRANSPORT=fake` in `vitest.config.ts`) keeps one outbox per recipient, `mail:fake:<email>`, with a 1-hour TTL. Production never writes it.

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

## node_runtime_posts

The node-runtime post ledger (TCS-69). It has one row per post URL of the nodejs.org vulnerability feed, with the outcome (`ok`, `empty`, `pending`, `failed`), the attempt count, the parser revision the post was read with and the next check time. It also keeps the feed title of the post and the count of CVE headings that the last read did not emit. `ok` and `empty` are terminal (only the newest feed post in state `ok` or `empty` is read again, because Node edits a post in place). `pending` is a pre-announcement read again at its next check time. `failed` retries on `retry_schedule_minutes` until `next_check_at` is NULL. A pending or failed row that reaches `max_attempts` reads is `empty`. Rows are kept forever, the same as `advisories`. If a row is deleted, the ingester reads that post again. The feed sets the limit on the row count: 48 Security Release posts on 2026-10-23, with about 12 new posts each year. No delete job.

## KV `cursor:node-runtime` and `cursor:node-runtime:parser` (CURSORS namespace)

Two keys: the node-runtime cursor and the parser revision it was read with (TCS-6, TCS-30). Since TCS-69 no code reads or writes them: `node_runtime_posts` holds the per-post state and the parser revision. The old values stay in KV. They do not grow. No delete job.
