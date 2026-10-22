# Retention

One section per table. A new table that grows ships its own rule and its scheduled job in the same PR.

## advisories

Kept forever. This table is the product's history, and the feed cursor (`since=`) depends on every row staying in place. No delete job.

## advisory_sources

Kept forever. One row per `(source, source_id)`, with the same life as its advisory. No delete job.

## sources

A fixed set of rows (6 today: `osv`, `nvd`, `kev`, `epss`, `node-runtime`, `php-runtime`). It does not grow. `last_error` is overwritten on each run, never appended, so the row does not grow either. No delete job.

## settings

A small key/value table of run-time limits and knobs (today one row: `feed.anon_rate_per_minute`). Rows change in place by key; the table does not grow with traffic. No delete job.

## KV `rl:` keys (CURSORS namespace)

The `/v1/events` rate-limit counters, one key per client IP per minute (`rl:v1:<ip>:<minute>`). Each key is written with a 120-second TTL, so KV expires it on its own. No delete job.
