# TCS-39 plan (r2): Python runtime ingester (CPython advisories), /v1/check?python=

Ticket: Fortunian/tocsin#39. `Blocked-by: #6` is merged (e344048). The coordinator approved the source change below on 2026-10-22. The coordinator also set constraints C1 to C3. The r2 changes come from the PR #47 review BLOCK (metered-API rule).

## Source change
- On 2026-10-22, `https://api.github.com/repos/python/cpython/security-advisories?state=published&per_page=5` returned `[]`, with and without a token. CPython publishes no GitHub repository advisories.
- Source: the PSF advisory database.
  - Listing: `https://api.github.com/repos/psf/advisory-database/contents/advisories/python`.
  - Records: `https://raw.githubusercontent.com/psf/advisory-database/main/advisories/python/PSF-YYYY-N.json`, in OSV format, with GIT commit ranges only.
- Fixed version per release line: the PSF CVE record, `https://cveawg.mitre.org/api/cve/<CVE>`.
- Released check: `https://www.python.org/api/v2/downloads/release/?is_published=true`.

## Scope
1. `src/ingest/python-runtime-client.ts`: the seam.
2. `src/ingest/python-runtime-normalize.ts`: the pure parsers, `normalizePythonAdvisory` and `publishedDoc`.
3. `src/ingest/python-runtime-records.ts`: the ledger table reads and writes.
4. `src/ingest/python-runtime.ts`: the ingester and `PY_DEFAULTS`.
5. `migrations/0009_python_runtime_source.sql`: the source row.
6. `migrations/0011_python_runtime_records.sql`: the ledger table and `idx_python_runtime_records_state_next (state, next_check_at)`. The coordinator reserved 0010 for another PR.
7. `src/ingest/registry.ts`: the registry entry.
8. `docs/RETENTION.md`: the retention entries.

## Decisions
- D1. Ledger: there is one `python_runtime_records` row per PSF id. Its `state` is one of `ok`, `empty`, `pending` or `failed`.
  - `ok` is written after the upsert.
  - `empty` is terminal. It is written for a withdrawn record, a record with no CVE alias, a CVE record for another id, a REJECTED CVE, or a record with no release line. A data problem in this list is reported in `errors` one time.
  - `failed` is written on each HTTP or parse error, with `attempts` + 1 and `next_check_at` = now + `retry_minutes` x attempts. When `attempts` reaches `max_attempts` (3), `next_check_at` is NULL and the record is terminal.
  - While a terminal `failed` row exists, each run reports "N records failed terminally: PSF-…" in `errors`.
  - One record never stops the run.
- D2. No cursor. One batched primary-key read (`json_each`) checks each listed id against the ledger. The run then reads the ids with no row, plus the `failed` rows that are due. It reads newest first, at most `max_records`.
- D3. Metered reads: each run makes 1 GitHub listing call, conditional on KV `python:listing-etag`. A 304 is free. The run keeps the ETag only when it read every new id. The python.org read happens once per run, before any record read, and only when there is work.
- D4. Pending:
  - The run publishes the released lines at once. The action names those lines and states each unreleased fix.
  - The row is `pending`. `unreleased` holds `{doc, lines:[{fixed, since}], dropped}`, and `next_check_at` = now + `pending_recheck_minutes` (60).
  - When a pending row is due, the run reads only python.org.
  - A line that is still unreleased after `pending_max_days` (90) is dropped, with a `last_error` note. The row then ends `ok`, or `empty` if no line has a release.
  - There is no KV TTL.
- D5. If a GitHub listing has 1000 entries, the run records "listing truncated at 1000 entries" in `errors` and continues.
- D6. Lines: a line needs a final `lessThan` and must be `min_line` (3.9) or newer. Pre-release fixes are dropped. There is no upper line cap.
- D7. The dedup key is the PSF id. The CVE is known only after the PSF record is read. Each record has 1 CVE alias.

## Known gap
- While a line is pending, the published advisory does not hold that line's range. So `/v1/check` reports a version on that line as not affected until python.org lists the fix. The coordinator chose this behavior ("publish the released lines").

## Acceptance tests (tests/ingest/python-runtime.tcs-39.test.ts, 29 tests)
- 3 recorded advisories yield 3 advisories with the right lines. A 304 second run makes 0 other reads. With no ETag, a second run also makes 0 reads because the ledger has every id.
- With an empty ledger, all 5 ids are read, newest first. `max_records` 2 works. An out-of-order listing (45 before 44) still reads 44. A 1000-entry listing makes the run record the warning.
- A 404 CVE record makes the row `failed` with attempts 1, and the run continues. After the third 404 the row is terminal: a fourth run makes 0 reads for it, and `errors` names it.
- A record with no release line becomes `empty` and is not read again. A CVE record for another id becomes `empty` and is reported.
- EXPLAIN QUERY PLAN at 2000 rows: the known-ids read uses the primary key, and the due read and the terminal read use `idx_python_runtime_records_state_next`.
- Pending: the released line is published at once. The re-check reads only python.org. The 90-day drop writes its note. Through `runIngesters`, the source row is ok.
- `GET /v1/check?python=3.12.4` and `python=3.13.16`.

## Pin tests extended (TEST-CHANGE)
- `tests/cron/run.tcs-2.test.ts` case 3b.
- `tests/worker/migrations.tcs-1.test.ts` (0009, 0011, 7 sources).
- `tests/routes/site-plan.tcs-10.test.ts` (7 rows).
- `tests/routes/site.tcs-10.test.ts` (status source ids).
