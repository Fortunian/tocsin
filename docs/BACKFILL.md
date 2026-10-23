# OSV backfill

The OSV ingester cron reads only what OSV modified after its cursor. The backfill loads the full
history of each OSV ecosystem once, from `https://osv-vulnerabilities.storage.googleapis.com/<eco>/all.zip`.
A Worker cannot hold these files (npm is about 219 MB), so the import runs in GitHub Actions:
`.github/workflows/backfill.yml` runs `scripts/backfill/run.mjs`. The script unzips the file,
sorts the records by id, skips `MAL-` and withdrawn records, and posts the rest in batches to
`POST /v1/internal/import`. The worker normalizes and stores each record with the same
`normalizeOsv` and `upsertAdvisory` as the cron, so a rerun writes no duplicate.

## Setup (one time)

1. Make a random token. Example: `openssl rand -hex 32`.
2. Set it as the worker secret: `wrangler secret put IMPORT_TOKEN`.
3. Set the same value as the GitHub Actions secret `TOCSIN_IMPORT_TOKEN` of the repo.
4. Optional: set the repo variable `TOCSIN_URL` when the host is not `https://tocsin.sh`.

Without the worker secret, the route answers 403 to every request.

## Run

1. Open Actions, workflow `backfill`, "Run workflow".
2. Select one `ecosystem` (`npm`, `PyPI`, `Go`, `Packagist`, `crates.io` or `RubyGems`). Keep `batch` at 100.
3. Do this once per ecosystem. Two runs for one ecosystem never run at the same time.
4. Read the progress line per batch in the run log. The last line is
   `backfill: <eco>: done at <time>: <n> imported, <n> unchanged, <n> skipped, <n> errors in <n> requests`.

A record with no package in an enabled ecosystem (for example a `Debian:12` record while Debian is
not enabled) counts as `skipped`, not as an error. The answer of the request names it in
`skipped_reasons.ecosystem_not_enabled`. OSV ecosystem strings with a suffix
(`Packagist:https://packages.drupal.org/8`) match on the part before the first `:`; the advisory
stores `ecosystem` as that base name and keeps the full string in `ecosystem_qualifier`.

A run that stops (a timeout, a 5xx after 3 retries) leaves the `backfill` row with `last_id` and no
`done_at`. Run the workflow again for that ecosystem: it resumes after `last_id`. A run after
`done_at` reads the whole file again and reports the records as `unchanged`.

The zip is a snapshot. It can be older than the record the cron already read from the OSV API.
When the stored record (created by the same OSV id) has a later `modified` than the zip copy,
the import does not write it. The answer counts it in `stale`, and the record counts as
`unchanged`. An older snapshot never replaces a newer record.

## Re-run one ecosystem after a normalizer change

Run the `backfill` workflow again with that `ecosystem` (for example `ecosystem=Packagist`).
The row has `done_at`, so the script reads the whole zip again and sends `start: true`, which
resets the counters of the row. Records already stored count as `unchanged`; records the old
normalizer dropped (the `DRUPAL-*` records before TCS-71) count as `imported`. The cron reads
new ones from then on.

## Feed consumers

Each record that the backfill inserts or updates gets a new feed cursor. A consumer that polls
`GET /v1/events` sees the backfilled history (years of old advisories) as new events after the
run. Use `published_at` to tell old advisories from new ones. A later delivery feature must not
treat backfill events as new advisories.

The batch size is capped by the settings row `import.max_batch` (default 100). One new record
costs about 5 D1 queries, and a Worker invocation may run 1,000 D1 queries (paid plan). Do not
set the row or the `batch` input above 150. If the worker answers 500 on a batch because of the
D1 query limit, lower the row, for example to 50, and run again. `import.max_body_bytes` (default 8 MB) caps one request body.

## Read the result

- `GET /v1/status`: `coverage[]` has one item per OSV ecosystem with `complete` and `imported`.
- `/status`: the Coverage table.
- `GET /v1/internal/import/<eco>` with the bearer token: the raw `backfill` row.

`sources.coverage_since` of row `osv` is set when every enabled ecosystem has `done_at`.
Until an ecosystem is done, `/v1/check` reports its dependencies with no finding as
`partial_coverage`, not as clean.

## After the backfill

Set the repo variable `COVERAGE_CHECK_ENABLED=1`. The `launch-check` workflow then also runs
`cov-lodash`, `cov-django` and `cov-count` (`scripts/launch-check.sh`).

## Add an ecosystem

Add the OSV ecosystem name to `ecosystems` in `sources.config_json` of row `osv`, add it to the
workflow's `ecosystem` options, and run the workflow for it.

## Runtimes

The runtime sources need no workflow. Each one sets its own `sources.coverage_since` after one
run that read its whole history:

- `node-runtime`: migration 0015 sets `max_posts` 20 and `backfill_days` 4000 in its config row,
  and the parser revision 3 moves the cursor back to the window start once. The cron then reads
  the feed's Security Release posts 20 per run (48 posts on 2026-10-22: 3 runs). An old post
  that is incomplete or gone (404) is reported in `last_error` and passed, so the read never
  stops there (`retry_incomplete_days`, 365).
- `node-eol`: one advisory per Node.js release line past its end of life, from the nodejs/Release
  `schedule.json`. A version on such a line is never clean.
- `deno-runtime`, `bun-runtime`: while `coverage_since` is NULL, a run ignores its KV cursor and
  ETag and reads every page once.
- `python-runtime`: the PSF listing is the whole history. A complete run with no record still
  retrying sets `coverage_since`.
- `php-runtime`: no history read yet, so `php` stays partial.
