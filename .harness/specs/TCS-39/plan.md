# TCS-39 plan: Python runtime ingester (CPython advisories), /v1/check?python=

Ticket: Fortunian/tocsin#39. `Blocked-by: #6` is merged (e344048). Coordinator note (2026-10-22) approved the source change below and added three constraints (C1 to C3).

## Source change
- `https://api.github.com/repos/python/cpython/security-advisories?state=published&per_page=5` answered `[]` on 2026-10-22, with and without a token. CPython publishes no GitHub repository advisories.
- Source: the PSF advisory database, `https://api.github.com/repos/psf/advisory-database/contents/advisories/python` (listing) and `https://raw.githubusercontent.com/psf/advisory-database/main/advisories/python/PSF-YYYY-N.json` (records, OSV format). The PSF records carry only GIT commit ranges.
- Fixed version per release line: the PSF CVE record, `https://cveawg.mitre.org/api/cve/<CVE>` (`containers.cna.affected[].versions[]`, `version` .. `lessThan`).
- Released check: `https://www.python.org/api/v2/downloads/release/?is_published=true`.

## Scope
1. `src/ingest/python-runtime-client.ts`: the seam (listing with optional `GITHUB_TOKEN` and `If-None-Match`, PSF record, CVE record, releases). `PythonHttpError`.
2. `src/ingest/python-runtime-normalize.ts`: pure parsers and `normalizePythonAdvisory`.
3. `src/ingest/python-runtime.ts`: `pythonRuntime` ingester, `PY_DEFAULTS` (config fallbacks), KV keys, `PY_DEDUP_SQL`.
4. `migrations/0009_python_runtime_source.sql`: `INSERT OR IGNORE` the `python-runtime` row, enabled, `'{}'`.
5. `src/ingest/registry.ts`: the `python-runtime` entry. `/v1/check?python=` and the CLI `python --version` detection already exist (pep440 comparator, `PYPI_CANDIDATE_SQL` covers ecosystem `python`).

## Decisions
- D1. One advisory per PSF record (one CVE alias). `sources[0].source_id` = the PSF id, so the dedup seek on `(python-runtime, PSF id)` runs before the PSF record read and before the CVE record read (C1). The CVE is not known before the PSF record is read, so a CVE key cannot run first. Cross-source merge still uses `cve_primary`.
- D2. Cursor: KV `cursor:python-runtime` = the last handled PSF id in (year, number) order. PSF ids are allocated in publish order. With no cursor, the ids of the years in the `backfill_days` window are read.
- D3. Metered reads (C1): 1 GitHub listing per run, conditional on KV `python:listing-etag` (a 304 is free). The ETag is stored only when the run handled every new id. `max_records` (default 50) caps new records per run.
- D4. Lines: `affected` entries with status `affected`, a final `lessThan` (x.y.z) and a release line >= `min_line` (default `3.9`). Pre-release fixes (3.15.0rc3) are dropped. No upper line cap: 3.15.x is already released on python.org.
- D5. An unreleased fix (C2): KV `python:pending:<PSF id>` = `{psf, cve, unreleased, doc}`, TTL `pending_ttl_days` (7), refreshed on each re-check. The cursor moves past it. Later runs re-check only pending records (releases read only). No error: the source marks ok; `RunResult.deferred` = pending count, `incomplete` = true.
- D6. Severity: CNA `cvssV4_0`, else `cvssV3_1`, else `cvssV3_0` (score + baseSeverity). Summary: CNA title. Timestamps: PSF `published` / `modified`.
- D7. Terminal, no error: withdrawn PSF record, REJECTED CVE, no supported line. Errors: malformed record, no CVE alias, CVE record for another id.

## Acceptance tests (tests/ingest/python-runtime.tcs-39.test.ts)
- 3 recorded advisories (PSF-2026-42..44) yield 3 advisories with the right lines, fixed versions, severity and action.
- Second run: If-None-Match, 304, 0 record/CVE/releases reads. Cursor reset: `unchanged` 3 with 0 PSF or CVE reads.
- `GET /v1/check?python=3.12.4` returns the 3, each `fixed_in` 3.12.15; `python=3.13.16` returns none of them.
- `EXPLAIN QUERY PLAN` of `PY_DEDUP_SQL` seeks `sqlite_autoindex_advisory_sources_1` at 2000 rows.
- Pending: a fix missing on python.org writes the pending key, stores the other 2, no error; the next run stores it with a 304 listing + 1 releases read; through `runIngesters` the source row is ok with `last_error` NULL.
- `max_records` 2, backfill window, seam headers, token only on the listing, 403 throws and keeps the cursor.

## Pin tests extended (TEST-CHANGE)
- `tests/cron/run.tcs-2.test.ts` case 3b, `tests/worker/migrations.tcs-1.test.ts` (0009, 7 sources), `tests/routes/site-plan.tcs-10.test.ts` (7 rows), `tests/routes/site.tcs-10.test.ts` (status source ids).
