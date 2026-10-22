# TCS-2 plan: Ingest framework + OSV ingester

Ticket: Fortunian/tocsin#2. Blocked-by #1 is CLOSED (merged as aaa6f23). The thread has 0 comments, so the issue body is the spec.
Already on main? No. `git log origin/main --since=2026-10-22T00:26:40Z -- src/ingest src/cron tests/ingest` shows only aaa6f23 (TCS-1 scaffold). TCS-1 left `src/cron/run.ts` as a stub that says "The ingest ticket replaces this body". `src/ingest/` does not exist.
CodeGraph: NOT AVAILABLE on this box. File set comes from reading the repo: `src/index.ts` is the only caller of `runCron`; `migrations/0001_init.sql` defines `sources`, `advisories`, `advisory_sources` and the 5 indexes this plan uses; `src/schema/advisory.ts` gives `Advisory` and `validateAdvisory`.

## Spec changes from comments
none

## Scope

1. `src/ingest/types.ts`: `Ingester { id; run(ctx): Promise<RunResult> }`, `RunResult = { fetched, upserted, unchanged, errors: string[] }`, `IngestContext = { env, source (the sources row incl. parsed config), now: () => Date, fetch: typeof fetch }`, `AdvisoryInput = Omit<Advisory, "id">`.
2. `src/ingest/registry.ts`: `defaultRegistry: Record<string, Ingester>` = `{ osv }`. `runIngesters(env, registry, now)`: reads `SELECT id, kind, config_json FROM sources WHERE enabled = 1 ORDER BY id`, runs each row whose `id` has an ingester, in sequence, inside its own try/catch. Writes per source after its run:
   - success with `errors.length === 0`: `last_run_at = now, last_ok_at = now, last_error = NULL`.
   - thrown error, or `errors.length > 0`: `last_run_at = now, last_error = <message, max 1000 chars>`; `last_ok_at` unchanged.
   - enabled row with no registered ingester (nvd, kev, epss, node-runtime, php-runtime today): skipped, row not written, one log line.
   Returns a per-source summary array and logs one JSON line per source.
3. `src/ingest/upsert.ts`: `upsertAdvisory(db, doc: AdvisoryInput, { source, source_id }) → "inserted" | "updated" | "unchanged"`, plus `canonicalJson(x)` (recursive sorted keys, no whitespace).
   - Read 1: `SELECT s.advisory_id, a.doc_json FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = ? AND s.source_id = ?` (PK of advisory_sources, then PK of advisories).
   - Present: build the stored doc (merge rules below), `canonicalJson` it, byte-compare with `doc_json`. Equal → `unchanged`, 0 writes. Different → `UPDATE advisories SET <indexed columns>, doc_json = ?, cursor = (SELECT COALESCE(MAX(cursor), 0) + 1 FROM advisories) WHERE id = ?`.
   - Absent and the doc has a CVE: Read 2 `SELECT a.id, a.doc_json FROM advisories a WHERE a.cve_primary = ? AND NOT EXISTS (SELECT 1 FROM advisory_sources s WHERE s.advisory_id = a.id AND s.source = ?) ORDER BY a.cursor LIMIT 1`. A hit → attach: one `db.batch([UPDATE advisories … new cursor, INSERT INTO advisory_sources])`. The correlated subquery runs only over the rows of one CVE (via `idx_advisories_cve_primary`, then `idx_advisory_sources_advisory_id`), never over the whole table.
   - Otherwise insert: `db.batch([INSERT INTO advisories (… cursor) VALUES (…, (SELECT COALESCE(MAX(cursor),0)+1 FROM advisories)), INSERT INTO advisory_sources])`. A D1 batch is one transaction, so a half-written advisory cannot exist.
   - Merge rules: the creator of an advisory is `doc.sources[0]` (merges always append). If the incoming `(source, source_id)` is the creator, the base fields come from the incoming doc; otherwise they come from the stored doc. Then `cve_ids`, `references` and `sources` are the ordered union of stored and incoming (sources keyed by `source + source_id`, creator stays first). `exploited` = stored OR incoming; `epss` = incoming if set, else stored (the enrichment ticket owns those two; OSV never sets them). `id` = stored id, or a new `tcs_` + ULID on insert.
   - Indexed columns derive from the stored doc: `cve_primary = cve_ids[0]` (cve_ids sorted ascending), `ecosystem`, `component`, `severity_label`, `severity_score`, `exploited` (0/1), `epss`, `published_at`, `modified_at`.
   - The stored doc is checked with `validateAdvisory` before any write. Invalid → throws `InvalidAdvisoryError` with the validator's messages; no write.
4. `src/ingest/ulid.ts`: `newAdvisoryId(now)` = `tcs_` + 26-char Crockford ULID (48-bit ms time + 80 bits from `crypto.getRandomValues`). Matches the schema pattern `^tcs_[0-9A-HJKMNP-TV-Z]{26}$`.
5. `src/ingest/osv-client.ts` (the OSV vendor seam; nothing else calls OSV): `listModifiedSince(fetch, base, ecosystem, sinceKey, maxRows)` streams `<base>/<ecosystem>/modified_id.csv` (newest first, lines `modified,id`) and stops at the first line with `modKey(modified) <= sinceKey`; `getVuln(fetch, apiBase, id)` does `GET <apiBase>/v1/vulns/<id>`. Non-2xx → throws `OsvHttpError(status, url)`. Reading past `maxRows` without reaching the cursor → throws (the run fails loudly; nothing is skipped silently).
6. `src/ingest/cvss.ts`: `cvss3BaseScore(vector)` for `CVSS:3.0/` and `CVSS:3.1/` vectors (FIRST spec formula with the spec's Roundup). Returns `undefined` for anything else (CVSS v4, malformed). `labelFromScore(score)`: >= 9.0 critical, >= 7.0 high, >= 4.0 medium, > 0 low, 0 unknown (CVSS spec bands, not business config).
7. `src/ingest/osv.ts`: the `osv` ingester plus the pure `normalizeOsv(vuln, ecosystems)`.
   - Config from `sources.config_json` of row `osv`, each key with a documented code fallback: `ecosystems` (`["npm","PyPI","Go","Packagist","crates.io","RubyGems"]`), `page_size` (25), `max_pages` (4), `backfill_days` (7), `skip_id_prefixes` (`["MAL-"]`), `max_csv_rows` (200000), `csv_base` (`https://osv-vulnerabilities.storage.googleapis.com`), `api_base` (`https://api.osv.dev`). The seed row stays `'{}'`, so prod runs on the fallbacks; no migration.
   - Run: read KV `cursor:osv` (absent → `now - backfill_days`, ISO). For each ecosystem list the ids modified after the cursor; drop skipped prefixes; dedupe by id keeping the max `modified`; sort ascending by `modKey(modified)`, then id.
   - Pages: cut the sorted list into pages of `page_size`. A page never splits a group of equal `modified` values (the page extends to the end of the group), so `> cursor` can never drop an unprocessed record. At most `max_pages` pages per run; the rest waits for the next tick (the cursor makes it resumable).
   - Per page: `getVuln` each id (sequential, so a page is at most 25 subrequests), `normalizeOsv`, `upsertAdvisory`. A fetch or D1 error throws out of the run: the cursor for that page is not written. A record that normalizes to an invalid doc, or has no affected package in a listed ecosystem, is a permanent data problem: it goes to `errors[]` as `<id>: <reason>` and the page still completes (otherwise one bad upstream record stops the cursor forever). After every record of a page is handled, `KV.put("cursor:osv", <max modified of the page>)`.
   - `fetched` counts records fetched, `upserted` counts inserted + updated, `unchanged` counts unchanged.
   - `modKey(ts)`: pads the fraction to 9 digits so `…05Z` and `…05.2Z` compare right (raw string compare puts `.` before `Z` and gets it wrong).
   - `normalizeOsv`: primary package = first `affected[]` entry whose `package.ecosystem` is in the list; other entries with the same package name and ecosystem add their ranges. `affected` = pairs from `ranges[].events` of type `SEMVER` or `ECOSYSTEM` (`GIT` skipped): `introduced` opens a range, `fixed` or `last_affected` closes it; a range still open at the end is emitted with `introduced` only. `fixed_versions` = unique `events.fixed` in order. Severity: the first `severity[]` entry with a CVSS v3 vector → score + label; else `database_specific.severity` (`CRITICAL/HIGH/MODERATE/LOW` → critical/high/medium/low); else `unknown`. `action` = `Upgrade <component> to <lowest fixed> or later.` when a fixed version exists, else `No fix published. Pin and monitor.` (cut to 200 chars). `lowest fixed`: compare dotted numeric parts, a pre-release tag sorts below its release. `cve_ids` = id and `aliases` matching `^CVE-\d{4}-\d{4,}$`, sorted; `ghsa_id` = id or alias matching the schema's GHSA pattern, else omitted. `summary` = OSV `summary`, else first non-empty line of `details`, newlines collapsed, cut to 200 chars; else `Advisory <id> affects <component>.`. `references` = `https://osv.dev/vulnerability/<id>` first, then OSV `references[].url` that match `^https?://`, unique. `sources` = `[{ source: "osv", source_id: id, url: "https://osv.dev/vulnerability/<id>" }]`. `published_at` = `published` or `modified`, kept as-is when it matches the schema pattern, else `new Date(x).toISOString()`. `exploited = false`.
8. `src/cron/run.ts`: `runCron(event, env, ctx, registry = defaultRegistry)` calls `runIngesters(env, registry, () => new Date())`. `src/index.ts` is not changed: it calls `runCron(event, env, ctx)` and gets the default registry.

## Files to touch
- `src/ingest/types.ts` (create)
- `src/ingest/registry.ts` (create)
- `src/ingest/upsert.ts` (create)
- `src/ingest/ulid.ts` (create)
- `src/ingest/osv-client.ts` (create)
- `src/ingest/cvss.ts` (create)
- `src/ingest/osv.ts` (create)
- `src/cron/run.ts` (modify)
- `tests/ingest/upsert.tcs-2.test.ts` (create)
- `tests/ingest/osv.tcs-2.test.ts` (create)
- `tests/ingest/osv-fake.ts` (create; the test-mode fake for the OSV seam)
- `tests/cron/run.tcs-2.test.ts` (create)
- `tests/unit/cvss.tcs-2.test.ts` (create)
- `tests/fixtures/osv/page1.json` (create; recorded from api.osv.dev during the build)

## Tests that must change
None

## Verify (run, not edited)
- `npm test` (includes `tests/worker/migrations.tcs-1.test.ts`, `tests/unit/schema.tcs-1.test.ts`, `tests/worker/health.tcs-1.test.ts`)
- `npm run typecheck`
- `npm run gen:schema -- --check`

## Tasks

T1. Types, ULID, canonical JSON.
Files: `src/ingest/types.ts`, `src/ingest/ulid.ts`.
VALIDATE: `npm run typecheck` exits 0; `npm test -- tests/ingest/upsert.tcs-2.test.ts -t "id"` passes (ids match `^tcs_[0-9A-HJKMNP-TV-Z]{26}$` and 1000 ids are unique).
SATISFIES: ticket scope line "`src/ingest/types.ts`: `interface Ingester { id: string; run(ctx): Promise<RunResult> }` where `RunResult = { fetched, upserted, unchanged, errors[] }`".

T2. `upsertAdvisory` with idempotency, cursor bump and cross-source merge.
Files: `src/ingest/upsert.ts`, `tests/ingest/upsert.tcs-2.test.ts`.
VALIDATE: `npm test -- tests/ingest/upsert.tcs-2.test.ts` passes, and goes red when (a) the byte-equal check is replaced by `return "updated"`, (b) the cursor subselect is removed from the UPDATE, (c) the CVE lookup is removed (mutation check, D1).
SATISFIES: ticket scope line "`src/ingest/upsert.ts`: `upsertAdvisory(doc, {source, source_id})` … Cross-source merge … merge `references` and `sources`" and acceptance "inserting the same `(source, source_id)` twice yields one row and `unchanged=1`; a changed doc gets a higher `cursor`; two sources with the same CVE yield one advisory with two `advisory_sources` rows".

T3. CVSS v3 base score.
Files: `src/ingest/cvss.ts`, `tests/unit/cvss.tcs-2.test.ts`.
VALIDATE: `npm test -- tests/unit/cvss.tcs-2.test.ts` passes on 4 known vectors with published scores (`CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` = 9.8, `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N` = 6.1, `CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H` = 7.8, `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:N` = 0.0) and returns `undefined` for a `CVSS:4.0/…` vector and for `garbage`.
SATISFIES: ticket scope line "severity from `severity[]` CVSS when present".

T4. OSV seam, fake and normalizer.
Files: `src/ingest/osv-client.ts`, `src/ingest/osv.ts` (`normalizeOsv`, `modKey`, lowest-fixed compare), `tests/ingest/osv-fake.ts`, `tests/fixtures/osv/page1.json`.
Fixture: the builder records 6 real records from `https://api.osv.dev/v1/vulns/<id>` (2 npm, 2 PyPI, 1 Go, 1 Packagist): at least 4 with a `fixed` event, at least 1 with no fixed event, at least 1 with a CVSS v3 vector, at least 1 with only `database_specific.severity`, at least 1 with a CVE alias. The file is a JSON array of the raw OSV records, unedited. The fake serves `modified_id.csv` per ecosystem built from the fixture's own `modified` and `id`, serves `/v1/vulns/<id>` from the fixture, and throws on any other URL (0 network calls by construction).
VALIDATE: `npm test -- tests/ingest/osv.tcs-2.test.ts -t "normalize"` passes: every fixture record normalizes, plus a placeholder id, to a doc that `validateAdvisory` accepts; `action` equals `Upgrade <component> to <lowest fixed> or later.` for each record with a fixed version and `No fix published. Pin and monitor.` for the others; `modKey("2026-10-21T22:45:05Z") > modKey("2026-10-21T22:45:05.2Z")` is false and the reverse is true.
SATISFIES: ticket scope line "Normalizes OSV JSON to advisory v1: affected ranges, fixed versions from `events.fixed`, severity …, `action` text …" and acceptance "with the fixture `tests/fixtures/osv/page1.json` (recorded from OSV, at least 5 advisories across 3 ecosystems) the ingester produces valid v1 docs; `action` is set for each with a fixed version".

T5. OSV ingester run: KV cursor, paging, cursor only after a full page.
Files: `src/ingest/osv.ts` (the `osv` ingester).
VALIDATE: `npm test -- tests/ingest/osv.tcs-2.test.ts -t "run"` passes: (a) after one run over the fixture with `page_size` >= 6, `CURSORS.get("cursor:osv")` equals the max `modified` in page1.json and the 6 stored `doc_json` rows pass `validateAdvisory`; (b) with page 1 = the fixture and a 7th listed id whose `/v1/vulns/` fetch throws, the run throws and the cursor equals page 1's max `modified`; (c) a second run over the same data fetches 0 vulns and changes no `cursor` column; (d) a page boundary inside a group of equal `modified` values extends the page; (e) a `MAL-` id in the CSV is never fetched. Mutation: writing the cursor before the page loop makes (b) red.
SATISFIES: ticket scope lines "pulls modified advisories from OSV for ecosystems `npm`, `PyPI`, `Go`, `Packagist`, `crates.io`, `RubyGems` using the OSV API with a `modified_since` cursor stored in KV (`cursor:osv`)" and "Cursor advance is written only after a fully successful page", and acceptance "the KV cursor equals the max `modified` in the page after a successful run; a thrown error on page 2 leaves the cursor at page 1's value".

T6. Registry and cron wiring.
Files: `src/ingest/registry.ts`, `src/cron/run.ts`, `tests/cron/run.tcs-2.test.ts`.
VALIDATE: `npm test -- tests/cron/run.tcs-2.test.ts` passes: the test inserts 2 source rows with ids unique to the test (`tcs2-pass-<n>`, `tcs2-fail-<n>`), disables the 6 seed rows for that test file's isolated D1, calls `runCron(createScheduledController(), env, ctx, registry)` with one ingester that throws and one that returns ok; both ingesters ran; the failing row has `last_error` set and `last_ok_at` NULL; the passing row has `last_error` NULL and `last_ok_at` set; both have `last_run_at`. A second case: an ingester that returns `errors: ["x"]` gets `last_error` and no `last_ok_at`. A third case: an enabled row with no ingester stays untouched. A fourth case (D2): `worker.scheduled` from `src/index.ts` with every source disabled resolves and makes 0 `fetch` calls. Mutation: removing the per-source try/catch makes the first case red.
SATISFIES: ticket scope lines "`src/ingest/registry.ts`: … The cron reads enabled rows from `sources`, runs each ingester in sequence, writes `last_run_at`, `last_ok_at`, `last_error`. One failure never stops the others." and "`src/cron/run.ts` calls the registry", and acceptance "a registry with one failing and one passing ingester runs both and records `last_error` on the failing source only".

T7. EXPLAIN proof for the new queries.
Files: `tests/ingest/upsert.tcs-2.test.ts`.
VALIDATE: `npm test -- tests/ingest/upsert.tcs-2.test.ts -t "EXPLAIN"` passes on 2000 seeded advisories + 2000 advisory_sources rows: read 1 plan contains `sqlite_autoindex_advisory_sources_1` and no `SCAN`; read 2 plan uses `idx_advisories_cve_primary` and `idx_advisory_sources_advisory_id`; `SELECT COALESCE(MAX(cursor),0)+1 FROM advisories` uses `idx_advisories_cursor`; `SELECT … FROM sources WHERE enabled = 1` is a scan of a 6-row table and is noted as such.
SATISFIES: repo iron rule 2 ("Every query on a new table has an `EXPLAIN QUERY PLAN` proof") and rule 8 ("no unbounded scans"), for the query shapes the ticket's upsert scope line requires.

## Edge cases
- Same `(source, source_id)` twice, same content → `unchanged`, cursor unchanged.
- OSV `modified` with 0, 2, 8 or 9 fraction digits, compared through `modKey`.
- Equal `modified` across a page boundary (extend the page).
- One OSV id listed in two ecosystem CSVs (dedupe, keep max `modified`).
- OSV record whose affected packages are all outside the 6 ecosystems (error line, page continues).
- Record with only `GIT` ranges → `affected: []`, `fixed_versions: []`, action "No fix published. Pin and monitor."
- Record with CVSS v4 only → label from `database_specific.severity`, no score.
- Summary longer than 200 chars or with newlines.
- Two concurrent cron runs: the second insert of one `(source, source_id)` fails on the advisory_sources PK; the batch rolls back, that run throws, and the next tick sees the row (no duplicate advisory).
- KV cursor absent (first run) → `now - backfill_days`.
- A 5xx from OSV → `OsvHttpError`, run fails, cursor stays, `last_error` names status and URL.

## Iron laws applied
- Sortable headers, list-over-cards, drill-down, 375px, loading.tsx: n/a, no UI in this ticket.
- Additive-only schema / RLS: no migration in this ticket. D1 has no RLS.
- Indexes for every query: all queries use the 0001 indexes; T7 proves it with EXPLAIN on 2000 seeded rows.
- No per-row correlated subquery over a large table: read 2's `NOT EXISTS` runs only for the advisories of one CVE (1-3 rows), through `idx_advisory_sources_advisory_id`. The cursor subselect is a MAX over an index (1 index seek).
- Retention: no new table. The only new stored item is KV key `cursor:osv` (1 key, overwritten). `advisories`/`advisory_sources` keep their "kept forever" rule in `docs/RETENTION.md`; `sources.last_error` is overwritten and cut to 1000 chars.
- DB-driven config: all OSV knobs read from `sources.config_json` with documented code fallbacks (repo iron rule 5). Severity bands are CVSS-spec constants, not business parameters.
- Model ids / De-AI / LLM: no LLM call. Summary and action are deterministic from OSV data (repo rules 6 and 10).
- Dedup before spend: OSV is free and unmetered. Still, the KV cursor and the `modified` filter mean a re-run fetches 0 records (T5 case c).
- Scalable tests (BH-7563), vendor OSV: seam = `src/ingest/osv-client.ts` (only file that builds an OSV URL; the `fetch` is injected through `IngestContext`); fake = `tests/ingest/osv-fake.ts` (fixture-backed, throws on an unknown URL); contract test = not in this PR (see ASSUMPTIONS). Each test file seeds its own rows with test-unique ids; vitest-pool-workers gives each test file its own D1.
- Bounded recurring work (D21): per run at most `max_pages * page_size` = 100 vuln fetches + 6 CSV reads, sequential; CSV read capped at `max_csv_rows`.

## Performance
No screen or route. The cron loader's reads per record: 1 indexed read when unchanged; 2 reads + 1 batch (2 statements) on insert/attach; 1 read + 1 write on update. Reads per record are sequential on purpose (each depends on the one before). Records within a page run sequentially to stay inside the Workers subrequest limit. Expected per tick at fallbacks: <= 106 subrequests to OSV, <= 100 * 4 = 400 D1 statements, 1 KV read, <= 4 KV writes. Skeleton: n/a.

## Changed symbols
- function `runCron`: body replaced by a call to `runIngesters`; new optional 4th parameter `registry` (default `defaultRegistry`). callers: left alone: `src/index.ts` keeps the 3-argument call and gets the default.
- function `upsertAdvisory`: new.
- function `runIngesters`: new.
- function `normalizeOsv`: new.
- function `cvss3BaseScore`: new.
- function `newAdvisoryId`: new.
- format KV key `cursor:osv`: new; value = OSV `modified` string (RFC3339 UTC) of the last fully processed page. Writer: `src/ingest/osv.ts`. Reader: `src/ingest/osv.ts`.

## Sibling claims (not touched)
`/root/harness/state/claims/tocsin/` is empty at plan time. TCS-3, TCS-4 and TCS-5 are planning in parallel; the issue map in `docs/PLAN_2026-10-21.html` puts them in `src/routes/`, `src/check/parsers/` and `src/check/match/`. This plan touches none of those.

## ASSUMPTIONS
- The OSV REST API has no "modified since" query. Assumed: the id list comes from OSV's documented per-ecosystem `modified_id.csv` in the `osv-vulnerabilities` bucket (verified live on 2026-10-22: newest first, `modified,id`), and each record comes from `GET api.osv.dev/v1/vulns/<id>`. Other reading: `POST /v1/querybatch` per package, which needs a package list we do not have.
- One KV key `cursor:osv` for all 6 ecosystems (the ticket names one key). The merged list is processed oldest first so one cursor is correct. Other reading: one key per ecosystem.
- `MAL-` ids (OSV malicious-package reports, thousands per week in npm) are skipped by default (`skip_id_prefixes`). The ticket's action text "Pin and monitor" is wrong for a malicious package, and repo rule 10 forbids a guessed action. Other reading: ingest them with that action text.
- One OSV record = one advisory (the PK is `(source, source_id)`). Primary package = the first affected entry in a listed ecosystem; affected entries for other packages are dropped. Other reading: one advisory per affected package, which needs a different `source_id` scheme.
- Cross-source merge only matches an advisory that has no row from the same source. Two OSV records with the same CVE (for example GHSA and PYSEC) stay 2 advisories. Other reading: merge them too, which would fold a PyPI advisory into an npm one.
- "Different source created it": the creator is `doc_json.sources[0]`; the creator's updates replace the base fields, an attached source only adds `cve_ids`, `references` and `sources`. Unions never drop an old reference. Other reading: last writer wins on every field.
- A record that cannot be normalized to a valid doc is an `errors[]` line and the page still advances; the run then records `last_error` and not `last_ok_at`. Transient errors (HTTP, D1) throw and stop the cursor. Other reading: any bad record blocks the cursor, which stops OSV ingest forever on one malformed upstream record.
- Defaults `page_size` 25, `max_pages` 4, `backfill_days` 7 are code fallbacks; the seeded `osv` row stays `'{}'`. The Workers plan (free 50 / paid 1000 subrequests) is not known here, so the default stays near 100 fetches per tick.
- Test files are named `tests/<dir>/<area>.tcs-2.test.ts` (harness per-ticket naming) in the directories the ticket names, not the exact names `upsert.test.ts`, `osv.test.ts`, `run.test.ts`.
- No OSV real-vendor contract suite in this PR: the repo has no main/nightly contract lane yet. A contract test belongs with that lane.
- CVSS v4 scores are not computed (the v4 formula needs the spec's lookup tables); a v4-only record takes its label from `database_specific.severity`.

## System invariants
(a) Cross-run state: the ingest watermark is KV `cursor:osv` (one key, single writer = the osv ingester, value is an OSV `modified` timestamp, compared through `modKey`). Dedup is the `advisory_sources` PRIMARY KEY `(source, source_id)` in D1, a natural unique key; it is never pruned. Feed order is `advisories.cursor` (UNIQUE), assigned as `MAX(cursor)+1` inside the same statement that writes the row.
(b) Side effects: D1 write per record (a batch = one transaction; failure throws, nothing half-written); KV cursor write per page, only after every record of the page returned or was recorded as a permanent error. A failed page leaves the cursor at the last full page, so the next tick refetches it and the upsert returns `unchanged` for rows already written. `sources` status write: success requires both no throw and `errors.length === 0`; `last_ok_at` is never written on a failure path. OSV not reachable → `last_error` with status and URL.
(c) Adversarial negatives for the cross-source merge (the only matcher with a client-visible effect, since it folds two records into one feed item): must NOT merge (1) two records of the same source with the same CVE; (2) a record with no CVE (null `cve_primary`, never `= NULL` matched); (3) a record whose CVE only appears in another advisory's non-primary `cve_ids`; (4) a CVE that differs only by case or whitespace is not produced, since the alias regex is exact and uppercase. Tests in `upsert.tcs-2.test.ts` cover (1), (2), (3).
(d) Neighbors: one cron (`*/10 * * * *`) runs all ingesters in sequence; the bounded per-tick work (<= 106 OSV subrequests) keeps a tick well under the cron wall limit, so ticks do not overlap in normal runs, and an overlap is safe by (a). Later ingesters (TCS runtime and enrichment tickets) register in `defaultRegistry` and call `upsertAdvisory`; the merge rule (creator owns base fields, `exploited`/`epss` preserved) is the contract they inherit. The feed ticket reads `cursor`; every change bumps it, `unchanged` never does.

## Requirements coverage
| Requirement (ticket) | Task | Test |
|---|---|---|
| `Ingester` / `RunResult` types | T1 | typecheck; used by every test |
| Registry map from `sources.id` to ingester | T6 | run.tcs-2 case 1 |
| Cron reads enabled rows, runs in sequence | T6 | run.tcs-2 cases 1, 3 |
| Writes `last_run_at`, `last_ok_at`, `last_error` | T6 | run.tcs-2 cases 1, 2 |
| One failure never stops the others | T6 | run.tcs-2 case 1 (+ mutation) |
| Upsert: present + byte-equal → `unchanged` | T2 | upsert.tcs-2 "same pair twice" |
| Upsert: changed → update + new cursor | T2 | upsert.tcs-2 "changed doc higher cursor" |
| Upsert: absent → insert with new id and cursor | T1, T2 | upsert.tcs-2 "insert" |
| Cross-source merge by primary CVE, merge references and sources | T2 | upsert.tcs-2 "two sources same CVE" + negatives (c) |
| OSV ecosystems npm, PyPI, Go, Packagist, crates.io, RubyGems | T5 | osv.tcs-2 run (a) reads all 6 CSVs from the fake |
| `modified_since` cursor in KV `cursor:osv` | T5 | osv.tcs-2 run (a) |
| Normalize: affected ranges, fixed versions, CVSS severity, action text | T3, T4 | cvss.tcs-2; osv.tcs-2 normalize |
| `src/cron/run.ts` calls the registry | T6 | run.tcs-2 case 4 (through `src/index.ts`) |
| Cursor advance only after a fully successful page | T5 | osv.tcs-2 run (b) (+ mutation) |
| Out of scope: NVD, KEV, EPSS, runtime ingesters, feed route (negative) | T6 | run.tcs-2 case 3: an enabled row with no ingester is not written; `defaultRegistry` has exactly the key `osv` |

## Acceptance tests
- `tests/ingest/upsert.tcs-2.test.ts`: same `(source, source_id)` twice → 1 `advisories` row, 1 `advisory_sources` row, second call returns `unchanged`; changed doc → `cursor` greater than before, same `id`; sources `osv` and `nvd-fixture` with the same CVE → 1 advisory, 2 `advisory_sources` rows, `doc_json.sources` has 2 entries and the union of `references`; negatives (c)(1)-(3); invalid doc → throws, 0 rows; EXPLAIN cases (T7); ULID shape.
- `tests/ingest/osv.tcs-2.test.ts`: normalize cases (T4); run cases (a)-(e) (T5); a spy on `globalThis.fetch` records 0 calls in the whole file.
- `tests/cron/run.tcs-2.test.ts`: cases 1-4 (T6).
- `tests/unit/cvss.tcs-2.test.ts`: 4 known vectors + 2 rejects (T3).
Regression risk: `tests/worker/migrations.tcs-1.test.ts` (same tables, no change to them), `tests/worker/health.tcs-1.test.ts` (imports `src/index.ts`, which now pulls in `src/ingest/*`).

## QA screens
None. This ticket adds no route or screen. Prod check after deploy (not a browser pass): `sources` row `osv` shows `last_ok_at` set and `last_error` NULL after a cron tick, and `SELECT COUNT(*) FROM advisory_sources WHERE source = 'osv'` grows.

## Design collision check (BH-5791)

Checked 7 listed and 0 derived symbols against main aaa6f2322bf4..aaa6f2322bf4 and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 8
LINES: 700
DIFF_KB: 85

KIND: feature
SIZE: M
