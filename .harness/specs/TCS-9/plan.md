# TCS-9 plan: Check endpoint, "am I affected?"

Ticket: Fortunian/tocsin#9. Blocked-by #3, #4, #5: all three are CLOSED (checked 2026-10-22). The thread has 0 comments, so the issue body is the spec.
Already on main? No. `git log origin/main -S"/v1/check" -- src` is empty and `git grep "v1/check" origin/main -- src` finds nothing. Parsers (TCS-4, 7df21c0) and matcher (TCS-5, b41010e) are on main; this ticket wires them to a route.
CodeGraph: NOT AVAILABLE on this box. Callers below come from grep and reading the files.

## Spec changes from comments
none

## Scope
- `POST /v1/check`: multipart (field name = lockfile name) or JSON `{ dependencies, runtimes }`. Body cap 2 MB (413 over it).
- `GET /v1/check?node=..&php=..`: runtimes only.
- Candidate advisories by `(component, ecosystem)` in one D1 batch, chunks of 200 keys, index `idx_advisories_component_ecosystem`.
- Match with `src/check/match`. Answer `{ checked, affected[], skipped[], feed_cursor }`. `affected` items: `{dependency, advisory_id, cve_ids, severity, exploited, fixed_in, action, url}`, sorted by severity (critical first), then exploited first.
- Anonymous rate limit 20 checks per minute per IP, own counter, own setting row.
- Check endpoint in `llms.txt` and `/.well-known/tocsin.json`.
- Out of scope: saving a lockfile as a watch list, SBOM formats, CORS for POST (see ASSUMPTIONS).

## Files to touch
- `src/routes/check.ts` (new): the GET and POST handlers, input decoding, 400/413/415 answers.
- `src/check/run.ts` (new): `runCheck(db, deps, skipped)`: candidate load, match, sort, `feed_cursor`.
- `src/check/candidates.ts` (new): `candidateKeys(deps)` and `CANDIDATE_SQL`, `FEED_CURSOR_SQL` (exported so the plan test runs the exact SQL).
- `src/middleware/ratelimit.ts`: add `makeRateLimit({ settingKey, fallback, scope })`; `rateLimit` (feed) becomes `makeRateLimit` with the feed values, same KV key, same behavior. Add `checkRateLimit`.
- `src/check/parsers/index.ts`: add export `SUPPORTED_FILENAMES` (the `BY_NAME` keys plus `requirements-*.txt`). Additive.
- `src/check/match/index.ts`: add export `supportsEcosystem(ecosystem)` (`Object.hasOwn(COMPARATORS, ecosystem)`). Additive.
- `src/app.ts`: `app.route("/v1/check", check)`.
- `src/routes/discovery.ts`: `endpoints.check` in WELL_KNOWN; a "Check your dependencies" section in LLMS_TXT.
- `migrations/0004_check_settings.sql` (new): `INSERT OR IGNORE` rows `check.anon_rate_per_minute=20`, `check.max_body_bytes=2097152`.
- `docs/RETENTION.md`: settings section lists the 2 new rows; KV section adds the `rl:v1:check:<ip>:<minute>` key family (120 s TTL, no delete job).
- `tests/routes/check.tcs-9.test.ts` (new), `tests/routes/check-plan.tcs-9.test.ts` (new), `tests/fixtures/check/package-lock.tcs-9.json` (new, small v3 lockfile: 1 affected + 1 safe npm package).
- `tests/worker/migrations.tcs-1.test.ts`: the pinned migration list gains `0004_check_settings.sql` (see Tests that must change).

## Tests that must change
- `tests/worker/migrations.tcs-1.test.ts`: it pins the exact applied migration list as 0001..0003; this ticket adds `0004_check_settings.sql`.

## Verify (run, not edited)
- `npm test` (all suites, including `tests/routes/ratelimit.tcs-3.test.ts`, `tests/routes/events*.tcs-3.test.ts`, `tests/routes/discovery.tcs-3.test.ts`)
- `npm run typecheck`

## Tasks

### T1. Settings rows for the check limits
Add `migrations/0004_check_settings.sql` with two `INSERT OR IGNORE` rows: `check.anon_rate_per_minute` = `20`, `check.max_body_bytes` = `2097152`. Comment header: additive only, retention in docs/RETENTION.md. Update `tests/worker/migrations.tcs-1.test.ts` list (title "applies 0001..0004"). Update `docs/RETENTION.md`.
VALIDATE: `npm test -- tests/worker/migrations.tcs-1.test.ts tests/routes/check-plan.tcs-9.test.ts -t "settings"` passes; the check-plan file asserts both rows exist with those values.
SATISFIES: "Anonymous rate limit 20 checks per minute per IP" and "Body cap 2 MB" (CLAUDE.md rule 5: limits are DB rows).

### T2. Rate limit factory, check counter separate from feed counter
In `src/middleware/ratelimit.ts` add `makeRateLimit({ settingKey, fallback, scope })`. KV key: `rl:v1:${ip}:${window}` when `scope` is empty (feed, unchanged), `rl:v1:${scope}:${ip}:${window}` otherwise. Export `rateLimit = makeRateLimit({ settingKey: "feed.anon_rate_per_minute", fallback: 60, scope: "" })` and `checkRateLimit = makeRateLimit({ settingKey: "check.anon_rate_per_minute", fallback: FALLBACK_CHECK_RATE_PER_MINUTE /* 20 */, scope: "check" })`. Keep `FALLBACK_RATE_PER_MINUTE` export name.
VALIDATE: `npm test -- tests/routes/ratelimit.tcs-3.test.ts` stays green unchanged, and `npm test -- tests/routes/check.tcs-9.test.ts -t "rate limit"` passes: 20 GETs from one IP answer 200, the 21st answers 429 with `Retry-After`; 60 feed requests from the same IP before that do not consume the check budget.
SATISFIES: "Anonymous rate limit 20 checks per minute per IP."

### T3. Candidate query and feed cursor
`src/check/candidates.ts`:
- `candidateKeys(deps)`: distinct `[ecosystem, name]` pairs. For `PyPI` and `python`, also add `normalizePypiName(name)` (the matcher compares normalized names; the query must not miss them).
- `CANDIDATE_SQL = "SELECT doc_json FROM advisories WHERE (component, ecosystem) IN (SELECT json_extract(value, '$[1]'), json_extract(value, '$[0]') FROM json_each(?))"`. One bound parameter per chunk: D1 allows at most 100 bound parameters per statement, and a 200-key chunk would need 400.
- `FEED_CURSOR_SQL = "SELECT COALESCE(MAX(cursor), 0) AS c FROM advisories"`.
- If EXPLAIN shows the row-value IN form does not use `idx_advisories_component_ecosystem`, the builder uses `FROM json_each(?) AS k CROSS JOIN advisories a ON a.component = json_extract(k.value,'$[1]') AND a.ecosystem = json_extract(k.value,'$[0]')` instead. The plan test decides; record which form shipped in the PR body.
VALIDATE: `npm test -- tests/routes/check-plan.tcs-9.test.ts` passes: on 2,000 seeded advisories, `EXPLAIN QUERY PLAN CANDIDATE_SQL` contains `USING INDEX idx_advisories_component_ecosystem` and matches no `/SCAN advisories(?! USING)/`; `FEED_CURSOR_SQL` plan uses `idx_advisories_cursor`.
SATISFIES: "loads candidate advisories by (ecosystem, component) in one batched query ... chunks of 200" and "`tests/routes/check-plan.test.ts`: the candidate query uses `advisories(component, ecosystem)`."

### T4. runCheck: match, sort, skipped, feed_cursor
`src/check/run.ts` `runCheck(db, deps, parseSkipped)`:
1. Split deps: `supportsEcosystem(dep.ecosystem)` false → `skipped` `{dependency, reason: "unsupported_ecosystem"}`. The rest are checked; `checked` = their count (distinct after parser dedup).
2. One `db.batch([FEED_CURSOR_SQL, ...chunks of 200 keys])`. FEED_CURSOR first so `feed_cursor` is never past an advisory the check did not see. Zero keys → batch has only the cursor statement.
3. Parse each `doc_json`, dedupe by advisory id, group by `ecosystem\0component` (and normalized PyPI name).
4. For each dep and its candidates: `matchAdvisory`. `affected` → item `{ dependency, advisory_id: a.id, cve_ids: a.cve_ids, severity: a.severity, exploited: a.exploited, fixed_in: r.fixed_in ?? null, action: a.action, url: a.sources[0].url }`. `skipped` result → one entry per `(dependency, reason)` with the advisory ids listed.
5. Sort `affected`: severity rank (critical 4, high 3, medium 2, low 1, unknown 0) desc, then exploited desc, then advisory_id asc, then dependency name asc (stable, deterministic).
6. Return `{ checked, affected, skipped: [...parseSkipped, ...matchSkipped], feed_cursor }`.
VALIDATE: `npm test -- tests/routes/check.tcs-9.test.ts -t "sort"` passes: a critical + exploited, a critical, and a high advisory on 3 seeded npm packages come back in exactly that order.
SATISFIES: "returns { checked: n, affected: [{dependency, advisory_id, cve_ids, severity, exploited, fixed_in, action, url}], skipped: [...] } sorted by severity then exploited" and "Response includes feed_cursor".

### T5. Route: POST and GET /v1/check
`src/routes/check.ts`, mounted in `src/app.ts` at `/v1/check`. Middleware order: `checkRateLimit` first, then (POST only) a body cap: read `check.max_body_bytes` (fallback 2 MB) and run Hono `bodyLimit({ maxSize, onError })` from `hono/body-limit`; `onError` answers 413 `{error: "body over <n> bytes"}`.
- POST `multipart/form-data`: each entry; key = filename; value `File` → `text()`, string → as is. `detect(key, text)` null → 400 `{ error: "unsupported lockfile name", file: key, supported_filenames: SUPPORTED_FILENAMES }`. `LockfileParseError` → 400 `{ error, file }` (narrow catch, any other error rethrows). Parser `skipped` entries get `file: key`. No entries → 400.
- POST `application/json`: invalid JSON or not an object → 400. `dependencies` must be an array if present; `runtimes` an object if present; at least one present → else 400. A dependency item that is not `{ecosystem, name, version}` non-empty strings → `skipped` `{raw, reason: "invalid dependency"}`. Runtimes go through `parseRuntimes`. Dedup with the parser's `ResultBuilder`.
- Any other content type → 415 `{ error, accepted: ["multipart/form-data", "application/json"] }`.
- GET: query params → `parseRuntimes` (first value per key). No known runtime param → 400 `{ error, supported_runtimes: RUNTIMES }`.
- Every answer through `jsonUtf8`, `Cache-Control: no-store`.
VALIDATE: `npm test -- tests/routes/check.tcs-9.test.ts` passes (cases listed in Acceptance tests), through `exports.default.fetch` (the production entry).
SATISFIES: "POST /v1/check accepts either multipart/form-data ... or JSON", "Body cap 2 MB", "GET /v1/check?node=24.22.0&php=8.4.26 is the no-body shortcut", acceptance test lines for 413 and 400.

### T6. Discovery files
`src/routes/discovery.ts`: `endpoints.check = "https://tocsin.sh/v1/check"`. LLMS_TXT gets a short section: the GET shortcut example (`curl "https://tocsin.sh/v1/check?node=24.22.0"`), the POST multipart example (`curl -F "package-lock.json=@package-lock.json" https://tocsin.sh/v1/check`), the JSON form, the answer shape, the 2 MB cap, `feed_cursor` → `since=`, and the per-IP limit. The schema `well-known.v1.json` already allows extra endpoint keys; no schema change.
VALIDATE: `npm test -- tests/routes/check.tcs-9.test.ts -t "discovery"` passes: `/.well-known/tocsin.json` has `endpoints.check === "https://tocsin.sh/v1/check"` and still validates; `/llms.txt` contains `/v1/check` and `feed_cursor`. `npm test -- tests/routes/discovery.tcs-3.test.ts` stays green.
SATISFIES: "Add the check endpoint to llms.txt and /.well-known/tocsin.json."

### T7. Exports for the route
`src/check/parsers/index.ts`: `export const SUPPORTED_FILENAMES = [...Object.keys(BY_NAME), "requirements-*.txt"]`. `src/check/match/index.ts`: `export function supportsEcosystem(e: string): boolean`.
VALIDATE: `npm run typecheck` exits 0, and the 400 test in T5 asserts `supported_filenames` contains `package-lock.json` and `requirements-*.txt`.
SATISFIES: "a lockfile with an unknown name returns 400 with the list of supported filenames."

## Changed symbols
- route `POST /v1/check`: new.
- route `GET /v1/check`: new.
- function `rateLimit` (src/middleware/ratelimit.ts): now built by `makeRateLimit`; same setting key, same KV key, same answers. callers: left alone: `src/routes/events.ts` keeps `events.use("*", rateLimit)` unchanged.
- function `makeRateLimit`, `checkRateLimit`: new.
- function `runCheck`, `candidateKeys`: new.
- function `supportsEcosystem`, constant `SUPPORTED_FILENAMES`: new exports.
- format `/.well-known/tocsin.json`: adds `endpoints.check`.
- format `/llms.txt`: adds the check section.

## ASSUMPTIONS
- Test file names: the ticket says `tests/routes/check.test.ts` and `check-plan.test.ts`; the harness requires per-ticket names, so they are `check.tcs-9.test.ts` and `check-plan.tcs-9.test.ts`. Other reading: the exact names.
- Body cap and rate limit are settings rows (rule 5) with 2 MB and 20 as code fallbacks. Other reading: code constants.
- The check counter is separate from the feed counter (`rl:v1:check:` keys). Other reading: one shared per-IP counter, which would let feed polling eat the check budget.
- `dependency` in an affected item is the `{ecosystem, name, version}` object. Other reading: a `name@version` string.
- `url` is the advisory's first source url (`sources[0].url`, schema requires at least 1 source; rule 10 "a fact from a source with a link"). Other reading: the tocsin event url `https://tocsin.sh/v1/events/<id>`.
- `fixed_in` is `null` when the matcher finds no fixed version above the dependency version (key always present).
- `checked` counts distinct dependencies in a supported ecosystem. Dependencies in other ecosystems are listed in `skipped` as `unsupported_ecosystem`, never silently counted as clean.
- An unparseable lockfile with a known name answers 400 naming the file. Other reading: list it under `skipped` and answer 200.
- `feed_cursor` is `MAX(cursor)` read in the same batch, before the candidate reads. An empty table gives 0.
- CORS stays GET/HEAD/OPTIONS. Agents call from servers; a browser POST is not in the ticket. Other reading: add POST to `allowMethods` in `src/app.ts`.
- Both GET and POST answer `Cache-Control: no-store`: a cached check would hide a new advisory.
- The 2026-10-21 php advisory is seeded in the test from the doc text (CVE-2026-109618, `php`, fixed 8.4.27 et al.), because the php-runtime ingester and its fixture do not exist yet. The node one uses `tests/fixtures/advisory/valid.json`.

## Edge cases
- Body with no Content-Length (chunked): Hono `bodyLimit` counts the stream and answers 413.
- Exactly 2 MB passes; 2 MB + 1 byte is refused. A 3 MB body is 413 before any parse.
- Repeated GET param (`?node=1&node=2`): first value wins.
- Unknown GET key (`?ruby=3`): listed in `skipped` as "unknown runtime" (parser behavior); if no known runtime remains, 400.
- Same package at 2 versions: 2 dependencies, each matched.
- PyPI name case/punctuation (`Django` vs `django`): both raw and normalized names are queried.
- More than 200 keys: multiple chunks in the same batch; test with 450 keys proves all chunks are read.
- Unsupported ecosystem from the JSON form (`Maven`): `skipped`, no query.
- Invalid version: matcher `skipped: invalid_version` reported once per dependency.

## Performance
- Reads per request: GET: settings (rate), KV get, KV put, 1 D1 batch (1 + ceil(keys/200) statements). POST adds settings (body cap). Expected D1 round trips: GET 2, POST 3. The rate limit settings read and KV get already run in parallel.
- Indexes: candidates use `idx_advisories_component_ecosystem` (0001_init.sql); `MAX(cursor)` uses `idx_advisories_cursor`; settings lookups use the primary key. Proven by T3 EXPLAIN on 2,000 rows.
- Bounded: body capped at 2 MB, so key count is bounded; the response only holds matched advisories.
- No screen, so no loading skeleton.

## Iron laws applied
- Additive schema: 0004 is two `INSERT OR IGNORE` rows; no new table, so no new index or retention job. New KV key family has a 120 s TTL (RETENTION.md).
- DB-driven config: both limits are settings rows.
- No LLM, no metered call: dedup-before-spend does not apply. De-AI: no LLM text.
- UI rules (sortable headers, list over cards, drill-down): no UI in this ticket.
- RLS: D1, not Supabase; n/a.
- Scalable tests: no vendor is called; tests use the miniflare D1/KV and seed their own rows with unique id prefixes and unique client IPs.

## Build discipline rules that bite
- D2: every route test goes through `exports.default.fetch` (src/index.ts), so deleting the mount in app.ts fails tests.
- D1: mutate checks: drop the sort → sort test red; drop the 413 → cap test red; share the feed counter → rate limit test red; drop PyPI normalization → PyPI case test red.
- D9/D10: `LockfileParseError` caught narrowly; other errors reach `app.onError` (500).
- D11: invalid input is refused (400), never clamped.
- D12: unsupported ecosystems and unmatched versions go to `skipped`, never counted clean.
- D6: record real exit codes of `npm test` and `npm run typecheck`.

## System invariants
- (a) Cross-run state: only the KV rate counter (`rl:v1:check:<ip>:<minute>`, TTL 120 s), same store and design as the feed counter. No new table.
- (b) External side effects: none. The route is read-only over D1. A KV write fault lets the request through (existing feed behavior, logged).
- (c) Matcher gating client-visible output: negatives the tests must include: a safe npm package (version at `fixed`) is not affected; `node 24.22.1` is not affected; a same-named package in another ecosystem is not matched; an ecosystem with no comparator is `skipped`, not affected.
- (d) Neighbors: the feed rate limiter (key unchanged, pinned by ratelimit.tcs-3 test); the cron ingest writes `advisories` while a check reads it (read-only batch, no lock); discovery test validates the well-known doc against its schema (extra keys allowed).

## Requirements coverage
| Requirement (ticket) | Task | Test |
|---|---|---|
| POST multipart, field name = filename | T5 | check.tcs-9 "package-lock fixture: one affected with fixed_in" |
| POST JSON `{dependencies, runtimes}` | T5 | check.tcs-9 "json body" |
| Body cap 2 MB | T1, T5 | check.tcs-9 "3 MB body returns 413" |
| Parse with src/check/parsers | T5 | check.tcs-9 package-lock case |
| One batched query, chunks of 200 | T3, T4 | check.tcs-9 "450 keys across chunks"; check-plan.tcs-9 |
| Match with src/check/match | T4 | check.tcs-9 node/npm cases |
| Answer shape `{checked, affected[...8 fields], skipped}` | T4 | check.tcs-9 asserts each field of the one affected item |
| Sorted by severity then exploited | T4 | check.tcs-9 "sort" |
| GET runtimes shortcut | T5 | check.tcs-9 `?node=24.22.0` and `?node=24.22.1` |
| `feed_cursor` for `/v1/events?since=` | T4 | check.tcs-9 "feed_cursor equals max cursor; events?since=feed_cursor is empty" |
| 20 checks/min/IP anonymous | T1, T2 | check.tcs-9 "rate limit" |
| llms.txt + well-known | T6 | check.tcs-9 "discovery" |
| Unknown lockfile name → 400 + supported list | T5, T7 | check.tcs-9 "unknown lockfile name" |
| Candidate query uses advisories(component, ecosystem) | T3 | check-plan.tcs-9 |
| Negative: no watch list saved (out of scope) | T5 (route is read-only) | check.tcs-9 "POST writes nothing": row counts of `advisories`, `advisory_sources`, `sources`, `settings` are unchanged after a POST |
| Negative: no SBOM formats | T5, T7 | check.tcs-9 "unknown lockfile name": a field named `bom.json` answers 400 |

## Acceptance tests
`tests/routes/check.tcs-9.test.ts` (vitest, workers pool, through `exports.default.fetch`, unique IP per test, ids via `idFor` with a TCS9-only prefix):
- Seed: node advisory from `tests/fixtures/advisory/valid.json`; php CVE-2026-109618 (`php`, ranges ending fixed 8.4.27, label critical, score 9.2); 3 npm advisories on packages in the fixture lockfile and one not in it.
- POST multipart `package-lock.json` = `tests/fixtures/check/package-lock.tcs-9.json` (1 affected + 1 safe): 200, `affected.length === 1`, item has `dependency`, `advisory_id`, `cve_ids`, `severity`, `exploited`, `fixed_in` (expected value), `action`, `url`; `checked === 2`.
- `GET /v1/check?node=24.22.0`: one affected item, `cve_ids` contains `CVE-2026-111497`, `fixed_in === "24.22.1"`.
- `GET /v1/check?node=24.22.1`: `affected` is `[]`.
- `GET /v1/check?node=24.22.0&php=8.4.26`: 2 items, php (critical) before node (high).
- POST 3 MB body: 413, JSON error.
- POST multipart with field `deps.lock`: 400, `supported_filenames` contains `package-lock.json`.
- POST JSON `{dependencies:[...], runtimes:{node:"24.22.0"}}`: same matches as the multipart form; a bad item lands in `skipped`.
- Sort: critical+exploited, critical, high in that order.
- 450 distinct npm deps (JSON form) with a vulnerable one at position 420: it is found (proves chunk 3 is read).
- PyPI `Django` dep vs advisory component `django`: matched.
- `Maven` dep: in `skipped` as `unsupported_ecosystem`, not counted in `checked`.
- `feed_cursor` equals the max seeded cursor; `GET /v1/events?since=<feed_cursor>` returns 0 events.
- Rate limit: pinned clock, 20 GETs → 200, 21st → 429 with integer `Retry-After`; another IP still 200; 60 feed reads first do not reduce the check budget.
- Discovery: `endpoints.check` and llms.txt section present; well-known still validates.
- Unsupported content type: 415.
- POST writes nothing: row counts of `advisories`, `advisory_sources`, `sources`, `settings` are the same before and after a POST.
`tests/routes/check-plan.tcs-9.test.ts`: 2,000 seeded advisories; EXPLAIN on `CANDIDATE_SQL` with a 200-key JSON param uses `idx_advisories_component_ecosystem`, no bare scan; `FEED_CURSOR_SQL` uses `idx_advisories_cursor`; settings rows `check.anon_rate_per_minute=20` and `check.max_body_bytes=2097152` exist.
Regression risk: `tests/routes/ratelimit.tcs-3.test.ts` (rate limit refactor), `tests/routes/discovery.tcs-3.test.ts` (well-known/llms), `tests/worker/migrations.tcs-1.test.ts` (migration list), `tests/routes/events*.tcs-3.test.ts` (shared middleware).

## QA screens
No browser screen. API checks after deploy:
- `curl -s "https://tocsin.sh/v1/check?node=24.22.0"`: one affected item, `fixed_in` 24.22.1 (only after the node-runtime ingester has run in prod).
- `curl -s -F "package-lock.json=@package-lock.json" https://tocsin.sh/v1/check`: 200 with `checked`, `affected`, `skipped`, `feed_cursor`.
- `curl -s https://tocsin.sh/.well-known/tocsin.json | jq .endpoints.check`.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section
TEST-CHANGE: <- Tests that must change (tests/worker/migrations.tcs-1.test.ts)
```

## Design collision check (BH-5791)

Checked 8 listed and 0 derived symbols against main b41010ee6257..b41010ee6257 and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 9
LINES: 340
DIFF_KB: 40

KIND: feature
SIZE: M
