# Plan: TCS-32 Full advisory backfill and honest coverage in /v1/check

Ticket: Fortunian/tocsin#32 (open, label `ai-build`, created 2026-10-22T20:07:05Z).
Blocked-by: #6 (hard). #6 is CLOSED, so the ticket is buildable.
Comment thread: 0 comments. The issue body is the full spec.

## Spec changes from comments

none

## Already on main?

No. `git log origin/main --since=2026-10-22T20:07:05Z` shows no commit after the
ticket. `grep -rn "coverage\|partial_coverage\|internal/import\|backfill" src packages/cli/src`
finds no match. `IMPORT_TOKEN`, a `backfill` table and `sources.coverage_since` do not exist.
Partly done by earlier work, and so not planned again:
- Node `max_posts` is already a config key: `readRuntimeConfig` reads it from
  `sources.config_json` of row `node-runtime` (`src/ingest/node-runtime.ts:27`, fallback 5).
  This plan only seeds an explicit value.
- The July 2026 wording fix of #30 is on main (07a9778, `NODE_PARSER_REV = "2"`).
- OSV `ecosystems` is already a config key (`src/ingest/osv.ts:13`, `readConfig`). Scope item 4
  needs no new code. The import route reads the same key.

## Scope

The ticket bundles four independent workstreams. This is XL. It must be split into
these child tickets, in this order:

- **C1 OSV backfill (scope item 1).** The `backfill` table, `sources.coverage_since`,
  `POST /v1/internal/import`, the Node import script and `.github/workflows/backfill.yml`.
- **C2 Honest coverage (scope item 3).** `coverage` in `/v1/check`, `partial_coverage` in
  `skipped`, coverage on `/v1/status` and `/status`, the CLI coverage line and exit 3.
  Blocked-by C1 (it reads the C1 table and column).
- **C3 Runtime history (scope item 2).** Node: seed `max_posts`, read every feed post once,
  one EOL advisory per end-of-life line. GitHub runtimes (python, deno, bun): set
  `coverage_since` after one full read. Blocked-by C1 (it writes `sources.coverage_since`).
- **C4 Prod gate (acceptance "Prod gate").** Opt-in coverage checks in
  `scripts/launch-check.sh`. Blocked-by C1, C2, C3.

Each child below has its own tasks, files, VALIDATE and SATISFIES lines.

### C1 tasks: OSV backfill

T1. Migration `migrations/0014_backfill.sql`.
- `CREATE TABLE IF NOT EXISTS backfill (ecosystem TEXT PRIMARY KEY, started_at TEXT, done_at TEXT, imported INTEGER NOT NULL DEFAULT 0, unchanged INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, last_id TEXT, coverage_since TEXT)`.
  Every query is by PK `ecosystem`, or a full read of a table with at most one row per
  enabled ecosystem (6 today). No secondary index is needed. A comment names this.
- `ALTER TABLE sources ADD COLUMN coverage_since TEXT;` (additive, NULL by default).
- `INSERT OR IGNORE INTO settings (key, value) VALUES ('import.max_batch', '500');`
- D1 is SQLite, not Supabase, so RLS does not apply.
VALIDATE: `npm run migrate:local` exits 0, then `wrangler d1 execute DB --local --command "PRAGMA table_info(backfill)"` lists the 8 columns.
SATISFIES: "Progress is a `backfill` table row per ecosystem (`started_at`, `done_at`, `imported`, `skipped`, `last_id`) so a rerun resumes" and "`sources` gets `coverage_since`".

T2. Import route `src/routes/internal-import.ts`, mounted in `src/app.ts` at `/v1/internal/import`.
- Auth first, before the body is read. No `Authorization: Bearer` header: 401.
  `IMPORT_TOKEN` unset, or a token that does not match: 403 (fail closed).
  Compare with `.trim()` on both sides and a constant-time compare (`crypto.subtle.timingSafeEqual`).
- `GET /v1/internal/import/:ecosystem` returns the `backfill` row (or a zero row). The script
  reads `last_id` from it to resume.
- `POST /v1/internal/import` body: `{ ecosystem, records: OsvVuln[], skipped: number, last_id: string, final?: boolean }`.
  - `ecosystem` must be in the OSV source's `ecosystems` config (the `readConfig` of `src/ingest/osv.ts`, exported). Otherwise 400.
  - `records.length > import.max_batch` (`getSettingInt`, fallback 500): 413. A body over a
    byte cap from settings `import.max_body_bytes` (seed 8 MB, fallback in code) also 413.
  - Each record: skip `MAL-` (the `skip_id_prefixes` config) and `withdrawn` records again on
    the server and count them as skipped. Then `normalizeOsv(v, cfg.ecosystems)` and
    `upsertAdvisory(db, d.doc, { source: "osv", source_id: d.source_id })` per doc. This is
    the same code path as the cron (`src/ingest/osv.ts:313`).
  - One `backfill` upsert per request: `INSERT ... ON CONFLICT(ecosystem) DO UPDATE` adds
    `imported`, `unchanged`, `skipped`; sets `last_id`; sets `started_at` only when NULL;
    keeps `coverage_since = MIN(coverage_since, oldest published_at in this batch)`.
  - `final: true`: sets `done_at`. Then, if every enabled OSV ecosystem has `done_at`, it sets
    `sources.coverage_since` of row `osv` to the MIN of their `coverage_since`.
  - Answer: `{ ecosystem, inserted, updated, unchanged, skipped, errors[], last_id, done_at }`.
- `src/app.ts`: the CORS middleware stays GET/HEAD/OPTIONS. The import route is not for browsers.
- `src/env.ts`: `IMPORT_TOKEN?: string`. `.env.example`: `IMPORT_TOKEN=` with the
  `wrangler secret put IMPORT_TOKEN` line.
VALIDATE: `npm test -- tests/routes/internal-import.tcs-32.test.ts`
SATISFIES: "write through one internal endpoint `POST /v1/internal/import` (bearer `IMPORT_TOKEN` worker secret, batches of 500, same `upsertAdvisory`, idempotent)".

T3. Import script `scripts/backfill/osv-import.mjs` (core) and `scripts/backfill/run.mjs` (CLI entry), plus `scripts/backfill/osv-import.d.mts` for the TS tests.
- `readZip(bytes)`: a small central-directory zip reader. Stored and deflate entries only.
  Deflate uses `DecompressionStream("deflate-raw")`, so the same code runs in Node 22 and in
  workerd (the api test project). No new npm dependency.
- `runBackfill({ zip, ecosystem, post, get, batch })`: sort entries by OSV id; read the
  resume `last_id` with `get`; skip ids `<= last_id`; skip `MAL-` and records with
  `withdrawn` and count them; send batches of `batch` records with `post`; the last batch
  carries `final: true`. Returns `{ imported, unchanged, skipped }`.
- `run.mjs`: downloads `https://osv-vulnerabilities.storage.googleapis.com/<eco>/all.zip`
  (base URL from env `OSV_BASE`, default that URL), reads `TOCSIN_URL` and `IMPORT_TOKEN`
  from env, `--batch` default 500. It retries a 5xx or network error 3 times with backoff,
  then exits 1. A 4xx exits 1 at once. It prints one line per batch.
VALIDATE: `npm test -- tests/backfill/import.tcs-32.test.ts`
SATISFIES: "download, unzip, skip `MAL-` and withdrawn records, normalize with the same `normalizeOsv` as the cron ... so a rerun resumes".

T4. Workflow `.github/workflows/backfill.yml`.
- `on: workflow_dispatch` with input `ecosystem` (choice: npm, PyPI, Go, Packagist, crates.io, RubyGems) and input `batch` (default 500).
- `runs-on: ubuntu-latest`, `timeout-minutes: 360`, Node 22, `node scripts/backfill/run.mjs`.
- Env: `TOCSIN_URL: ${{ vars.TOCSIN_URL || 'https://tocsin.sh' }}`, `IMPORT_TOKEN: ${{ secrets.TOCSIN_IMPORT_TOKEN }}`.
- `concurrency: backfill-${{ inputs.ecosystem }}` so two runs for one ecosystem never overlap.
VALIDATE: `node -e "const y=require('yaml');const w=y.parse(require('fs').readFileSync('.github/workflows/backfill.yml','utf8'));if(!w.on.workflow_dispatch.inputs.ecosystem)process.exit(1)"` exits 0, and `tests/backfill/workflow.tcs-32.test.ts` passes.
SATISFIES: "the import runs as a GitHub Actions workflow (`backfill.yml`, `workflow_dispatch` with an `ecosystem` input)".

T5. Docs: `docs/RETENTION.md` gets a `## backfill` section (one row per enabled ecosystem,
updated in place, does not grow, no delete job) and `sources.coverage_since` in the
`sources` section. `docs/BACKFILL.md` gets the operator steps (set the secret, run the
workflow per ecosystem, read the row).
VALIDATE: `grep -n "^## backfill" docs/RETENTION.md` prints one line.
SATISFIES: repo iron rule 2 ("Every table ships with its indexes and a retention rule").

### C2 tasks: Honest coverage

T6. Coverage read `src/check/coverage.ts`.
- `COVERAGE_SQL = "SELECT ecosystem, coverage_since, done_at FROM backfill"` and
  `SOURCE_COVERAGE_SQL = "SELECT id, coverage_since FROM sources WHERE enabled = 1"`.
- A fixed identity map from check ecosystem to coverage owner (not a knob; it names code):
  the six OSV ecosystems and runtime `go` map to the `backfill` row of the OSV ecosystem
  (`go` maps to `Go`); `node` maps to source `node-runtime`; `php` to `php-runtime`;
  `python` to `python-runtime`; `deno` to `deno-runtime`; `bun` to `bun-runtime`.
- `coverageFor(ecosystems, rows)`: `[{ ecosystem, since, complete }]`, sorted by ecosystem.
  `complete` is true only when the owner row has `done_at` (backfill) or a non-NULL
  `coverage_since` (source). An ecosystem with no owner row is `complete: false`.
VALIDATE: `npm test -- tests/check/coverage.tcs-32.test.ts`
SATISFIES: "`POST /v1/check` returns `coverage: [{ecosystem, since, complete}]`".

T7. `src/check/run.ts` `runCheck`.
- Add the two coverage statements to the existing single `db.batch` (still one round trip).
- `CheckResult` gets `coverage`. It lists every ecosystem of the checked dependencies.
- A checked dependency with no affected item and no other skipped reason, in an ecosystem with
  `complete: false`, goes to `skipped` as `{ dependency, reason: "partial_coverage", since }`.
  It is not counted as clean. A dependency with an affected item keeps it in `affected`.
VALIDATE: `npm test -- tests/check/coverage.tcs-32.test.ts tests/routes/check.tcs-9.test.ts`
SATISFIES: "a dependency in an ecosystem with `complete=false` is reported in `skipped` with reason `partial_coverage`, never as clean".

T8. Status. `src/site/data.ts`: `STATUS_SOURCES_SQL` selects `coverage_since`, and
`loadStatus` adds `COVERAGE_SQL` to its existing batch. `StatusData` gets
`coverage: { ecosystem, since, complete, imported }[]`. `site/status.ts`: `StatusSource`
gets `coverage_since`; `renderStatus` shows a "Coverage since" column in the sources table
and a coverage table per ecosystem. Both tables use the existing table markup of the status
page. If that markup has no sortable header, the new table gets the same markup and a NOTE.
VALIDATE: `npm test -- tests/routes/status-coverage.tcs-32.test.ts`
SATISFIES: "`GET /v1/status` and `/status` show it".

T9. CLI `packages/cli/src/check.ts`.
- `CheckResult.coverage` optional (an old server sends none). `merge` unions coverage by
  ecosystem; `complete` is false if any part says false.
- `print` adds one line: `Coverage: npm since 2016-01-05, PyPI partial (since 2026-10-15), ...`.
- Exit code: 1 when anything is affected; else 3 when any checked ecosystem has
  `complete: false`; else 0. `--json` output carries `coverage`.
- After #60 merges, the same rule goes into its `checkResult` and the `--summary` line says
  `(exit 3, partial coverage)`. See Design collisions.
VALIDATE: `npm test -- tests/cli/check-coverage.tcs-32.test.ts`
SATISFIES: "The CLI prints the coverage line and exits 3 when any checked ecosystem is partial".

### C3 tasks: Runtime history

T10. Node feed history. Migration `migrations/0015_node_history.sql`:
`UPDATE sources SET config_json = json_set(config_json, '$.max_posts', 20, '$.backfill_days', 4000) WHERE id = 'node-runtime' AND json_extract(config_json, '$.max_posts') IS NULL;`
(it never overwrites an edited value). `src/ingest/node-runtime.ts`: `NODE_PARSER_REV`
becomes `"3"`, so the next run reads the whole window once. The cursor still moves post by
post, so 77 posts take 4 cron runs of 20. When a run reaches the newest feed post and the
oldest feed post is inside the window, the run sets `sources.coverage_since` of
`node-runtime` to the oldest post date (only when it is NULL).
VALIDATE: `npm test -- tests/ingest/node-history.tcs-32.test.ts`
SATISFIES: "Node: `max_posts` becomes a config row; the backfill run reads all 77 posts".

T11. Node EOL lines. New ingester `src/ingest/node-eol.ts`, registered in
`src/ingest/registry.ts`, source row `node-eol` seeded in `0015_node_history.sql` with
`config_json` `{}` (fallbacks in code: `schedule_url`
`https://raw.githubusercontent.com/nodejs/Release/main/schedule.json`, `dist_index_url`).
- For each line in the schedule whose `end` date is before now: one advisory, ecosystem
  `node`, component `node`, `source_id` `eol-<major>`, severity `high`,
  `affected: [{ introduced: "<major>.0.0", last_affected: "<newest <major>.x in the dist index>" }]`,
  `fixed_versions: []`, summary `Node.js <major>.x is end of life (since <end>). It gets no security fixes.`,
  action `Upgrade node to <lowest supported LTS line>.x or later.` (computed from the
  schedule: the lowest even line whose `end` is after now), references the schedule URL and
  `https://nodejs.org/en/about/previous-releases`. `published_at` is the line's `end` date.
- Line `0.x` keys (`v0.10`, `v0.12`) map to `introduced: "0.10.0"` and so on.
- The dist index uses the KV cache of `node-runtime-dist.ts`.
VALIDATE: `npm test -- tests/ingest/node-eol.tcs-32.test.ts tests/check/coverage.tcs-32.test.ts`
SATISFIES: "The Node EOL lines (18.x and older) get one advisory per line ... so `node=18.19.0` is never clean".

T12. GitHub runtimes full read. `src/ingest/github-runtime.ts`: when the source's
`coverage_since` is NULL, the run ignores the KV cursor and its ETag and reads from the start
once. A run that completes without the `max_pages` stop sets `coverage_since` to the oldest
`published_at` it read (or the run time when it read 0 advisories). Upserts are idempotent,
so the re-read writes nothing new. `IngestContext.source` gets `coverage_since`
(`src/ingest/registry.ts` selects it).
VALIDATE: `npm test -- tests/ingest/github-runtime-coverage.tcs-32.test.ts`
SATISFIES: "Honest coverage ... `coverage_since` (the oldest `published_at` the source holds, NULL until the backfill is done)".

### C4 task: Prod gate

T13. `scripts/launch-check.sh`: three new checks, run only when `COVERAGE_CHECK=1`
(the launch-check workflow sets it after the backfill). With the flag unset the script
runs its five checks as today, so `tests/launch/launch-check.tcs-14.test.ts` does not change.
- `cov-lodash`: `POST /v1/check` JSON `npm lodash 4.17.15` lists CVE-2020-8203 and CVE-2021-23337.
- `cov-django`: `PyPI django 3.2.0` lists at least `COV_DJANGO_MIN` affected items (default 10).
- `cov-count`: for each ecosystem in `/v1/status` `coverage`, `imported` is at least
  `COV_MIN_PCT` (default 90) percent of the non-`MAL-` id count in OSV's `<eco>/modified_id.csv`.
- The summary line counts the extra checks (`<n> of 8 passed`).
- `.github/workflows/launch-check.yml`: env `COVERAGE_CHECK: ${{ vars.COVERAGE_CHECK_ENABLED }}`.
VALIDATE: `npm test -- tests/launch/launch-coverage.tcs-32.test.ts`
SATISFIES: "Prod gate (added to `scripts/launch-check.sh`): ... lodash ... django ... at least 90%".

## Files to touch

C1:
- `migrations/0014_backfill.sql` (new)
- `src/routes/internal-import.ts` (new)
- `src/app.ts`
- `src/env.ts`
- `src/ingest/osv.ts` (export `readConfig` only)
- `scripts/backfill/osv-import.mjs` (new)
- `scripts/backfill/osv-import.d.mts` (new)
- `scripts/backfill/run.mjs` (new)
- `.github/workflows/backfill.yml` (new)
- `.env.example`
- `docs/RETENTION.md`
- `docs/BACKFILL.md` (new)
- `tests/backfill/import.tcs-32.test.ts` (new)
- `tests/backfill/zip-fixture.tcs-32.ts` (new, test helper: builds the 1,000-record zip in memory)
- `tests/backfill/workflow.tcs-32.test.ts` (new)
- `tests/routes/internal-import.tcs-32.test.ts` (new)
- `tests/routes/backfill-plan.tcs-32.test.ts` (new, EXPLAIN QUERY PLAN)

C2:
- `src/check/coverage.ts` (new)
- `src/check/run.ts`
- `src/site/data.ts`
- `site/status.ts`
- `packages/cli/src/check.ts`
- `tests/check/coverage.tcs-32.test.ts` (new)
- `tests/routes/status-coverage.tcs-32.test.ts` (new)
- `tests/cli/check-coverage.tcs-32.test.ts` (new)
- `tests/routes/check.tcs-9.test.ts` (see Tests that must change)
- `docs/API.md` (the `coverage` field and the `partial_coverage` reason)

C3:
- `migrations/0015_node_history.sql` (new)
- `src/ingest/node-runtime.ts`
- `src/ingest/node-eol.ts` (new)
- `src/ingest/registry.ts`
- `src/ingest/types.ts`
- `src/ingest/github-runtime.ts`
- `tests/ingest/node-history.tcs-32.test.ts` (new)
- `tests/ingest/node-eol.tcs-32.test.ts` (new)
- `tests/ingest/github-runtime-coverage.tcs-32.test.ts` (new)
- `tests/fixtures/node-eol/schedule.json` (new)

C4:
- `scripts/launch-check.sh`
- `.github/workflows/launch-check.yml`
- `tests/launch/launch-coverage.tcs-32.test.ts` (new)

## Tests that must change

- `tests/routes/check.tcs-9.test.ts`: line 180 pins `skipped` as `[]` for a clean PyPI check. This ticket makes an uncovered ecosystem report `partial_coverage`. The test seeds a done `backfill` row for PyPI in its own setup, so the old premise holds where coverage is complete. The assertion stays `toEqual([])`.

## Verify (run, not edited)

- `npm test` (all five vitest projects)
- `npm run typecheck`
- `npm run migrate:local`
- `tests/routes/check-plan.tcs-9.test.ts`, `tests/routes/status-ledger.tcs-50.test.ts`, `tests/routes/site-freshness.tcs-35.test.ts`, `tests/check/go-runtime.tcs-40.test.ts`, `tests/cli/check.tcs-13.test.ts`, `tests/launch/launch-check.tcs-14.test.ts`, `tests/ingest/*node*` (regression suites)

## Changed symbols

- route `POST /v1/internal/import`: new.
- route `GET /v1/internal/import/:ecosystem`: new.
- function `readConfig` (`src/ingest/osv.ts`): exported, body unchanged. callers: left alone: `run` keeps its call.
- function `runCheck` (`src/check/run.ts`): adds `coverage` and `partial_coverage` skipped items.
- format `CheckResult` (`/v1/check` response): adds `coverage`; adds skipped reason `partial_coverage`. callers: left alone: the MCP worker and the Action pass the body through and ignore unknown fields.
- function `loadStatus` (`src/site/data.ts`): one more statement in its batch; returns `coverage`.
- format `StatusData` / `/v1/status` response: adds `coverage` and `sources[].coverage_since`.
- function `renderStatus` (`site/status.ts`): coverage column and table.
- function `runCheck` (`packages/cli/src/check.ts`): exit 3 on partial coverage; coverage line.
- function `merge` (`packages/cli/src/check.ts`): unions `coverage`.
- function `run` of ingester `node-runtime`: parser rev 3; sets `coverage_since`.
- function `run` of `github-runtime` ingesters: full read while `coverage_since` is NULL.
- verb `scripts/launch-check.sh`: three opt-in checks under `COVERAGE_CHECK=1`.
- format `backfill` table, `sources.coverage_since` column: new.

## Design collisions

- `runCheck`: combine — PR #60 (92c0e76985a2, TCS-28) splits the CLI `runCheck` (`packages/cli/src/check.ts`) into `checkResult` (returns `{ code, data? }`) and `runSummary`, and `runCheck` only dispatches on `--summary`/`--json`. C2 puts the exit rule in `checkResult` (`affected` → 1, else any `complete: false` → 3, else 0, always with `data`), and `runSummary` tests `!r.data` first: code 3 with no `data` stays "check failed (network)", code 3 with `data` prints `tocsin: 0 affected of N checked, … (exit 3, partial coverage)`. The server `runCheck` (`src/check/run.ts`) is not in #60, so T7 is unchanged.
- `CheckResult`: combine — #60 only matches by text: it uses the CLI `CheckResult` interface as the type of `checkResult().data` and does not change its fields. T9 adds the optional `coverage` field to that interface, and `checkResult`, `merge` and `runSummary` carry it with no further change. The server `CheckResult` (`src/check/run.ts`) is not in #60.
- `run`: combine — #60 changes the `run` property of the CLI `VERBS` table (`packages/cli/src/cli.ts`: the `check` verb gains `summary`, `connect` gains `hook` and `print-agents-md`). The plan's `run` is the `run` function of the `node-runtime` and `github-runtime` ingesters (T10, T12), which #60 does not touch, so both changes apply as written.

## Sibling claims (not touched)

`/root/harness/state/claims/tocsin/` is empty. No live sibling build.

## Edge cases

- A rerun of the import after `done_at`: every record answers `unchanged`; counters add only to `unchanged`; `done_at` is kept.
- A record whose packages are all in disabled ecosystems: `normalizeOsv` returns not ok; counted in `errors`, not a failure of the batch.
- A record with packages in two ecosystems (TCS-46): one doc per package. Import of `npm` also writes its `PyPI` doc. That is correct and idempotent.
- An import batch that dies half way: the `backfill` row is written last in the request, so `last_id` never passes a record that was not written. A retry re-sends the batch; the upsert makes it idempotent.
- `last_id` compare: plain string compare on the sorted id list, in the script and the server.
- `IMPORT_TOKEN` with a trailing newline: `.trim()` on both sides.
- A check of `node=18.19.0` before C3 runs: `node-runtime.coverage_since` is NULL, so the answer is `partial_coverage`, never clean.
- A check with no dependency in an ecosystem: `coverage` lists only the ecosystems that were checked.
- An old CLI against the new server: it ignores `coverage`; the `partial_coverage` item counts in its "skipped" line, so it is never shown as clean.
- A new CLI against an old server (no `coverage`): exit codes stay as today.

## Iron laws that apply

- Sortable headers, list over cards, drill-down: the `/status` coverage table is the only UI. It reuses the status table markup. No card grid. Each ecosystem row has no detail page to link to (NOTE).
- DB-driven config: `import.max_batch` and `import.max_body_bytes` are settings rows with code fallbacks. Node `max_posts` and `backfill_days` are seeded into the `node-runtime` config row. `node-eol` URLs are config keys with fallbacks. The EOL action line is computed from the schedule, not typed. `COV_MIN_PCT` and `COV_DJANGO_MIN` are env knobs of the script with documented defaults.
- RLS: not Supabase (D1). Not applicable.
- Indexes: `backfill` reads and writes are by PK or a full read of at most ~10 rows. `tests/routes/backfill-plan.tcs-32.test.ts` runs `EXPLAIN QUERY PLAN` on the `ON CONFLICT` write and the PK read and asserts `USING PRIMARY KEY` / `sqlite_autoindex_backfill_1`. The coverage reads of `sources` and `backfill` are full reads of small fixed tables. The import's upserts reuse the existing index-served `UPSERT_SQL`.
- No per-row correlated subquery over a large table: none added. `coverage_since` is stored, never computed by `MIN(published_at)` over `advisories` at read time.
- Retention: `backfill` is one row per ecosystem, updated in place. A doc section, no job.
- De-AI: no LLM. The EOL summary and action are fixed templates from data.
- Dedup before spend: no metered call. OSV GCS downloads are free and run in Actions. The NVD ingester will find many new CVEs to enrich; it already dedups through `nvd:queried:` KV keys and its per-run cap. EPSS is a full snapshot.
- Model id: none.
- Scalable tests: no vendor is called in tests. The import tests build the zip in memory and post to `SELF.fetch`. The node-eol test uses `tests/fixtures/node-eol/schedule.json` through the injected `ctx.fetch`. The `launch` test runs against Miniflare with fixtures.

## build-discipline rules that bite

- Per-ticket test files: every new test is `*.tcs-32.test.ts`. The one edit to another ticket's test is listed under Tests that must change.
- Surgical change: no refactor of `upsertAdvisory`, `normalizeOsv` or the check matchers.
- Additive schema: two `ADD COLUMN`/`CREATE TABLE` statements and seed rows only.
- New env var to every environment: `IMPORT_TOKEN` (wrangler secret, prod), `TOCSIN_IMPORT_TOKEN` (GitHub Actions secret), `TOCSIN_URL` (optional repo variable), `COVERAGE_CHECK_ENABLED` (optional repo variable). The PR body lists them.

## Performance

`/v1/check` reads: one `db.batch` as today. Statements: 1 (cursor) + key chunks + 0/1 (Go runtime) + 2 (coverage). Expected for a one-ecosystem check: 4 statements, was 2. All run in one round trip. Indexes: the existing candidate indexes; the two coverage reads scan tables of at most ~15 rows.
`/v1/status` and `/status`: one batch, statements 2 + ledgers + 1 (coverage). No list read added.
`POST /v1/internal/import`: per batch of 500 records, about 2 to 3 D1 calls per doc (the existing upsert) plus 1 `backfill` write. No page, no skeleton (not a screen). `/status` is server-rendered HTML with no loading route in this worker stack.

## ASSUMPTIONS

- The ticket is XL with four independent workstreams. I assumed the split C1 to C4 above. The other reading is one PR for all of it, which is over any review size.
- Normalization runs on the server (the import route calls `normalizeOsv`). The script only unzips, sorts, skips and batches. The other reading is a script that normalizes in Node; that needs the TS code compiled for the Actions run and two copies of the skip rule.
- `imported` counts docs inserted or updated, and `unchanged` counts the rest, so a second run reports 0 imported and N unchanged, as the acceptance test asks. The prod gate's 90% check compares OSV id counts with `imported + unchanged` of the `backfill` row, not with a `COUNT(*)` over `advisories` at read time (that is a 280k-row scan per status load).
- "batches of 500" is the fallback of settings row `import.max_batch`. A D1 limit on queries per Worker call can force a lower value. The operator lowers the row; the 413 follows the row.
- Per-ecosystem completeness for OSV comes from `backfill.done_at`. `sources.coverage_since` of row `osv` is set only when every enabled ecosystem is done. The other reading puts a per-ecosystem value on `sources`, which has one row for six ecosystems.
- A dependency that has at least one affected item stays in `affected`, and its ecosystem shows `complete: false` in `coverage`. Only a dependency with no finding goes to `skipped` as `partial_coverage`. The other reading puts every dependency of a partial ecosystem in `skipped`, which hides real findings.
- CLI exit code: 1 (affected) wins over 3 (partial), because affected is the more actionable answer. Exit 3 already means "the check could not run"; partial coverage reuses it as the ticket says.
- Runtimes with no history mechanism in this ticket (php until #29) report `complete: false`. python, deno and bun become complete after one full read (T12). The other reading leaves them partial forever or marks them complete with no proof.
- Node posts: the cron reads the history in runs of 20 posts (`max_posts` 20), not 77 in one run, to stay under the Worker subrequest cap. The ticket's "the backfill run reads all 77 posts" is met after 4 cron runs.
- EOL source is `nodejs/Release` `schedule.json` (a fact with a link, iron rule 10). `last_affected` is the newest release of that line in the dist index; `fixed_in` is null as the ticket says.
- PHP history (scope item 2, second half) is #29's work. This ticket builds nothing for PHP.
- The prod gate checks are opt-in (`COVERAGE_CHECK=1`). On by default, they would fail the existing launch test (no backfill in Miniflare) and fail prod until the backfill has run.
- Backfilled rows enter the feed with new cursors, so a feed reader at the head sees about 280k events once. Webhook delivery is still a stub (`src/queue/run.ts`), so no delivery is sent.
- The GitHub Action (`action/`) is not changed. It keeps its own exit rule.

## Failure modes

This plan changes no path under `bin/` or `worker/`. The section is not required. The import route's exit paths are in Edge cases.

## System invariants

(a) Cross-run state: the `backfill` table, natural key `ecosystem` (PK). It holds the resume watermark `last_id` and the done flag. `sources.coverage_since` is one value per source row. Node history uses the existing KV cursor plus a parser rev. Nothing is kept in config JSON except operator knobs.
(b) Side effects: the import writes advisories first, then the `backfill` row, in one request. On a D1 error the request answers 500 and the row is not moved; the script retries the same batch. `done_at` is set only by a request with `final: true` that wrote all its records. `coverage_since` of `osv` is set only after every enabled ecosystem has `done_at`. A missing `IMPORT_TOKEN` answers 403; nothing is written.
(c) Negative list for the `partial_coverage` rule (it changes a client-visible answer): it must not fire for (1) an ecosystem with `done_at` set; (2) a dependency with an affected item; (3) a dependency already skipped as `invalid_version` or `unsupported_ecosystem`; (4) runtime `go` when the `Go` backfill row is done; (5) an ecosystem name in different case from a lockfile (`pypi` vs `PyPI` is normalized by the parsers before the check). For the EOL rule it must not fire for 20.x, 22.x or 24.x while their `end` is in the future, nor for an odd line before its `end`. Tests include each case.
(d) Neighbors: the OSV cron (`cursor:osv`) keeps running during the import; both write through `upsertAdvisory` keyed on `(source, source_id)`, so a race gives `updated` or `unchanged`, never a duplicate. The NVD ingester's pending queue grows; its per-run cap and `nvd:queried:` dedup bound its calls. The sitemap pages by cursor range, so 280k rows add pages, not one big query. The home "Latest" table sorts by `published_at`, so old rows do not show as new. The rate limiter covers `/v1/check` and `/v1/events` only; the import route is not limited and is bearer-gated.

## Requirements coverage

| Requirement | Task | Acceptance test |
|---|---|---|
| Full OSV backfill per ecosystem from all.zip in GitHub Actions | T3, T4 | `tests/backfill/import.tcs-32.test.ts`, `tests/backfill/workflow.tcs-32.test.ts` |
| Skip MAL- and withdrawn records | T2, T3 | import test: skipped count |
| Same `normalizeOsv` and `upsertAdvisory`, idempotent | T2 | import test: second run 0 imported, all unchanged |
| `POST /v1/internal/import`, bearer `IMPORT_TOKEN`, batch 500 | T2 | `tests/routes/internal-import.tcs-32.test.ts` 401/403/413 |
| Route present in prod and authenticated (no prod-404) | T2 | internal-import test: route answers 401, not 404, with no test flag |
| `backfill` row per ecosystem, resume on rerun | T1, T2, T3 | import test: resume from `last_id`, row has `done_at` |
| Node `max_posts` config row; read all posts | T10 | `tests/ingest/node-history.tcs-32.test.ts` |
| Node EOL advisory per line 18.x and older | T11 | `tests/ingest/node-eol.tcs-32.test.ts`; coverage test `node=18.19.0` |
| PHP history | none (after #29) | n/a, see ASSUMPTIONS |
| `sources.coverage_since` | T1, T2, T10, T12 | import test; node-history test; github-runtime-coverage test |
| `/v1/status` and `/status` show coverage | T8 | `tests/routes/status-coverage.tcs-32.test.ts` |
| `/v1/check` returns `coverage` | T6, T7 | coverage test |
| Partial ecosystem dependency never clean | T7 | coverage test: PyPI no advisory, NULL coverage → `partial_coverage` |
| Complete ecosystem dependency clean | T7 | coverage test: `complete=true` → clean |
| CLI coverage line, exit 3 on partial | T9 | `tests/cli/check-coverage.tcs-32.test.ts` |
| Enabled ecosystems stay a config row | already on main; T2 reads it | internal-import test: ecosystem not in config → 400 |
| Prod gate in launch-check.sh | T13 | `tests/launch/launch-coverage.tcs-32.test.ts` |
| NEGATIVE: "clean with no hint" must stop | T7 | coverage test asserts no clean answer when coverage is partial |
| Out of scope: EPSS/KEV history, new ecosystems | none | n/a |

## Acceptance tests

- `tests/backfill/import.tcs-32.test.ts` (api project): builds a 1,000-record zip (990 valid records, 5 `MAL-`, 5 `withdrawn`) in memory; `runBackfill` with `batch: 500` posts to `SELF.fetch` with a test `IMPORT_TOKEN` binding. Asserts 2 POST calls; `imported` 990 docs; `skipped` 10; `backfill` row `done_at` set; a second run imports 0 and reports `unchanged` 990; a run killed after batch 1 and restarted resumes at `last_id` and sends only batch 2.
- `tests/backfill/workflow.tcs-32.test.ts` (api project, reads the yml as raw text through the raw-module pattern): `workflow_dispatch.inputs.ecosystem` exists; the run step reads `secrets.TOCSIN_IMPORT_TOKEN`.
- `tests/routes/internal-import.tcs-32.test.ts`: no bearer → 401; wrong bearer → 403; `IMPORT_TOKEN` unset → 403; 501 records → 413; 413 follows `import.max_batch` set to 10; ecosystem `Maven` (not enabled) → 400; the route answers 401 (not 404) with no test flag set.
- `tests/routes/backfill-plan.tcs-32.test.ts`: `EXPLAIN QUERY PLAN` of the `backfill` PK read and upsert uses the primary key.
- `tests/check/coverage.tcs-32.test.ts`: no done PyPI row → PyPI dependency with no advisory is in `skipped` with `partial_coverage`, `coverage` has `{ ecosystem: "PyPI", complete: false }`; with a done row → clean and `complete: true`; a dependency with an affected item in a partial ecosystem stays in `affected`; an `invalid_version` item does not also get `partial_coverage`; `go` runtime follows the `Go` row; with the node-eol advisory seeded, `GET /v1/check?node=18.19.0` returns it with `fixed_in` null; `node=22.12.0` does not get it.
- `tests/routes/status-coverage.tcs-32.test.ts`: `/v1/status` has `coverage` and `sources[].coverage_since`; `/status` HTML shows the coverage table.
- `tests/cli/check-coverage.tcs-32.test.ts`: a partial answer with no affected item → exit 3 and a `Coverage:` line; affected plus partial → exit 1; all complete and clean → exit 0; an answer with no `coverage` field → exit 0.
- `tests/ingest/node-history.tcs-32.test.ts`: a 77-post fixture feed, `max_posts` 20: 4 runs read all posts; `coverage_since` is set after run 4 and not before; the migration does not overwrite an edited `max_posts`.
- `tests/ingest/node-eol.tcs-32.test.ts`: the fixture schedule gives one advisory per ended line (incl. 18, 16, 0.12) and none for 20/22/24; action names the lowest supported LTS line; a re-run is `unchanged`.
- `tests/ingest/github-runtime-coverage.tcs-32.test.ts`: with `coverage_since` NULL and a stored cursor, the run reads from the start and sets `coverage_since`; a run stopped by `max_pages` does not set it.
- `tests/launch/launch-coverage.tcs-32.test.ts`: with `COVERAGE_CHECK=1` against the Miniflare worker seeded with the lodash and django fixtures and an `modified_id.csv` fixture, the three checks pass; with the lodash advisory removed `cov-lodash` FAILs and the script exits 1; with the flag unset the script prints `of 5 passed`.

Regression risk suites: `tests/routes/check.tcs-9.test.ts`, `tests/routes/check-plan.tcs-9.test.ts`, `tests/check/go-runtime*.test.ts`, `tests/routes/status-ledger.tcs-50.test.ts`, `tests/routes/site-freshness.tcs-35.test.ts`, `tests/cli/check.tcs-13.test.ts`, `tests/launch/launch-check.tcs-14.test.ts`, `tests/ingest/*node*`, `tests/ingest/*deno*`, `tests/ingest/*bun*`, `tests/ingest/*python*`, `tests/mcp/**` (the MCP check tool passes the body through).

## QA screens

- `https://tocsin.sh/status`: the sources table shows "Coverage since"; the coverage table lists the six OSV ecosystems and the runtimes with complete or partial. Check at 375px: the tables scroll inside their own container.
- `https://tocsin.sh/v1/status`: JSON has `coverage`.
- `https://tocsin.sh/v1/check?node=18.19.0`: the EOL advisory is in `affected`.
- `POST https://tocsin.sh/v1/check` with `npm lodash 4.17.15`: CVE-2020-8203 and CVE-2021-23337, and `coverage`.

```pr-body-requires
IMPORT_TOKEN <- T2 new env var (wrangler secret, prod)
TOCSIN_IMPORT_TOKEN <- T4 new GitHub Actions secret
TEST-CHANGE: tests/routes/check.tcs-9.test.ts <- Tests that must change
## ASSUMPTIONS <- plan ASSUMPTIONS section
```

## Design collision check (BH-5791)

Checked 12 listed and 0 derived symbols against main a281180b5257..a281180b5257 and 1 open PRs.
- `runCheck` (function, listed): PR #60 92c0e76985a2, body or signature changed. Resolution: combine.
- `CheckResult` (function, listed): PR #60 92c0e76985a2, (text match). Resolution: combine.
- `run` (function, listed): PR #60 92c0e76985a2, body or signature changed. Resolution: combine.

## Size

FILES: 22
LINES: 1250
DIFF_KB: 110

KIND: feature
SIZE: XL
