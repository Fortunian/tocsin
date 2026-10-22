# Retention

One section per table. A new table that grows ships its own rule and its scheduled job in the same PR.

## advisories

Kept forever. This table is the product's history, and the feed cursor (`since=`) depends on every row staying in place. No delete job.

## advisory_sources

Kept forever. One row per `(source, source_id)`, with the same life as its advisory. No delete job.

## sources

A fixed set of rows (6 today: `osv`, `nvd`, `kev`, `epss`, `node-runtime`, `php-runtime`). It does not grow. `last_error` is overwritten on each run, never appended, so the row does not grow either. No delete job.
