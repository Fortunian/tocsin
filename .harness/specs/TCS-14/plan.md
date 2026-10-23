# TCS-14 plan: launch gate script, README, launch post, source-request template

Ticket: Fortunian/tocsin#14 "Launch: real advisories in prod, README, post, public repo".
Base: this child is planned on the open parent branch `ticket/tcs-6-r3` (head ae804eb).
CodeGraph: NOT AVAILABLE on this box. Files were found with grep and read by hand.
Verification map: ABSENT in this repo. Routes were found by reading `src/app.ts` and `src/routes/`.

## Spec changes from comments
none

(The issue has 0 comments as of 2026-10-22 17:45Z. The body is the whole spec.)

## Already on main / parent?
No. `git log origin/ticket/tcs-6-r3 --since=2026-10-22T00:27:01Z` on README.md, scripts/, docs/LAUNCH_POST.md,
.github/ and tests/launch shows only TCS-1/3/12/13 commits, none of which add a launch check, a launch post or
an issue template. `scripts/` holds only `gen-advisory-validator.mjs`. Nothing of this ticket exists.

## Scope

1. `scripts/launch-check.sh`: a bash gate against a base URL (default `https://tocsin.sh`). Five checks. Exit 0 only if all pass, exit 1 on any failure.
2. `tests/launch/launch-check.tcs-14.test.ts`: runs the script against a local worker. The worker is seeded with the 2026-10-21 fixtures through the production cron path. Expect exit 0. With the node advisory removed, expect exit 1.
3. `README.md` final text: the three agent lines, the connect command, the schema link, self-host (`wrangler deploy`), "Built with" (Cromford, link cromford.ai), "How it was built" (PR list link, every PR carries its TCS key).
4. `docs/LAUNCH_POST.md`: about 400 words, Lior's voice, the fixed title, De-AI pass.
5. `.github/ISSUE_TEMPLATE/source-request.md`: a "Request a source" template.
6. `.github/workflows/launch-check.yml`: the nightly CI run of the script against prod ("runs in CI nightly after launch"). It is gated by the repo variable `LAUNCH_CHECK_ENABLED == '1'`, so it does not go red every night before launch.

Out of scope: paid ads, newsletter, Stripe (ticket 12/#15), setting the repo public (an operator action, see Requirements coverage).

## ASSUMPTIONS

- A1. "`GET /status` shows every source with `last_ok_at` within 24 hours". `/status` on main is an HTML page. The same data is JSON at `GET /v1/status` (`src/routes/status.ts`, `loadStatus` in `src/site/data.ts`, enabled sources only). I assume the script reads `/v1/status` JSON. Other reading: scrape the `/status` HTML. That is fragile and checks the same rows.
- A2. "every source" = every row `/v1/status` returns (enabled sources). In prod today `nvd`, `kev` and `epss` are enabled by `migrations/0002_seed_sources.sql` but have no ingester until #7 ships, so their `last_ok_at` stays NULL. The prod gate will therefore print FAIL for those three until #7 merges or an operator disables those rows. I assume this is the gate doing its job, and I do not change the source rows. Other reading: skip sources with no ingester. That would let the gate pass with dead sources, so I reject it.
- A3. "`GET /v1/check?node=24.22.0` returns one affected item". With the real 2026-10-21 data, node 24.22.0 is affected by 8 advisories (every 24.x line CVE in the post, `tests/ingest/node-runtime.tcs-6.test.ts:20-30`), and `runCheck` emits one item per advisory (`src/check/run.ts:65-80`). An exact count of 1 would fail against real data. I assume "at least one affected item, and one item carries CVE-2026-111497 with `fixed_in` = `24.22.1`". Other reading: `length == 1`, which is false for the real feed.
- A4. The ticket names the test `tests/launch/launch-check.test.ts`. The harness rule is per-ticket test file names, so the file is `tests/launch/launch-check.tcs-14.test.ts`. Same content.
- A5. "a local worker seeded with the 2026-10-21 fixtures". The api vitest project runs inside workerd, which cannot spawn bash. So the test runs in a new node-environment vitest project `launch`. It bundles `src/index.ts` with esbuild, starts it with Miniflare on a free localhost port, applies `migrations/`, and seeds by calling the worker's `scheduled` handler. Miniflare's `outboundService` answers every outbound `fetch` from the TCS-6 fixture files (the same 7 URLs as `tests/cron/runtime-ingest.tcs-6.test.ts` ROUTES). Any other URL gets a 599 and is recorded. `miniflare` and `esbuild` are already in the lockfile as wrangler dependencies. They are added to root `devDependencies` at the versions the lockfile already resolves, so the import is declared. Other reading: run `wrangler dev` as a subprocess and seed with SQL. That cannot intercept the ingesters' fetch and duplicates the upsert logic in SQL.
- A6. Seed only the two runtime sources. Like the TCS-6 cron test, the test sets `enabled = 0` for `osv`, `nvd`, `kev`, `epss` before the cron run, so only `node-runtime` and `php-runtime` run and appear in `/v1/status`. Other reading: also fake OSV. That adds fixtures no launch check reads.
- A7. `npx tocsin@latest connect --dry-run` downloads from npm. The script reads the command from `TOCSIN_CLI` (default `npx --yes tocsin@latest`). The test sets it to `node packages/cli/bin/tocsin.js`, after it compiles the CLI once (`npx tsc -p packages/cli/tsconfig.build.json`, output is the gitignored `packages/cli/dist`). The script always runs the CLI with `HOME` set to a fresh temp dir, so a dry run never reads an operator's real agent configs. "Prints the MCP block" = the output contains the MCP URL (`MCP_URL`, default `https://mcp.tocsin.sh/mcp`) and either `"mcpServers"` or `[mcp_servers.tocsin]` (`packages/cli/src/connect.ts:47,207-208`). The CLI exit code is printed but does not decide the check: a temp HOME with no agent tool prints the generic block and exits 0, other machines can print a "different entry" block.
- A8. "says what is free and what is paid". The pricing section of `docs/PLAN_2026-10-21.html` says "Free $0, everything at launch" and "Paid parked, no paid tier at launch". Watch lists (#8) and webhooks (#11) are still open. The post says: the feed, the check endpoint, the MCP server and the CLI are free with no account; there is no paid tier; watch lists and signed webhooks with a free API key are the next step. It does not claim watch lists or webhooks are live. Other reading: copy the landing line "An API key (free) for watch lists and signed webhooks", which describes features that are not shipped.
- A9. The title says "fetch() was exploitable". The Node post (fixture `tests/fixtures/node-runtime/2026-10-21.html:21-24`) names the Brotli decoder, not fetch. The post keeps Lior's title and states the link as one sourced sentence: Node's `fetch()` decodes `Content-Encoding: br` responses with that Brotli decoder, so a response from a hostile server reaches it. The post links the Node advisory. This sentence is flagged in the PR body for Lior's read, because it is the one inference in the post (iron rule 10).
- A10. The "nightly after launch" CI run is delivered as a workflow that is off until an operator sets `LAUNCH_CHECK_ENABLED=1`. Other reading: run it nightly from today. That would be red every night until #7 ships and DEPLOY is on.
- A11. `/v1/status` and the site routes come from TCS-10 (#24, merged on main as b598636). This branch (parent ae804eb) does not have them yet. The parent's file list includes `src/routes/status.ts` and `src/site/data.ts`, so the parent is expected to take main. Task T0 checks for `src/routes/status.ts`. If it is absent, the build merges `origin/main` into `ticket/tcs-14` (a merge commit, no edits to those files) so the local worker serves `/v1/status`.

## Stack

This child edits or creates only these files. None is in the parent's file list.

scripts/launch-check.sh
tests/launch/launch-check.tcs-14.test.ts
tests/launch/local-worker.tcs-14.ts
vitest.config.ts
package.json
package-lock.json
README.md
docs/LAUNCH_POST.md
.github/ISSUE_TEMPLATE/source-request.md
.github/workflows/launch-check.yml

## Files to touch

- `scripts/launch-check.sh` (new, mode 755)
- `tests/launch/launch-check.tcs-14.test.ts` (new)
- `tests/launch/local-worker.tcs-14.ts` (new, test helper: bundle, Miniflare boot, migrations, outbound fixture fake, seed)
- `vitest.config.ts` (add project `launch`; add `tests/launch/**` to the `api` project's `exclude`)
- `package.json` (add `miniflare` and `esbuild` to `devDependencies`, pinned to the lockfile's resolved versions)
- `package-lock.json` (root devDependency entries only, from `npm install`)
- `README.md` (rewrite to final text)
- `docs/LAUNCH_POST.md` (new)
- `.github/ISSUE_TEMPLATE/source-request.md` (new)
- `.github/workflows/launch-check.yml` (new)

## Verify (run, not edited)

- `npm test`, `npm run typecheck`, `npm run gen:schema -- --check`
- `bash -n scripts/launch-check.sh`, `shellcheck scripts/launch-check.sh` if installed
- `tests/cron/runtime-ingest.tcs-6.test.ts` (read for the fixture ROUTES map, not edited)

## Changed symbols

- format `scripts/launch-check.sh output`: new. One line per check, `ok <check>` or `FAIL <check>: <reason>`, then `launch-check: <n> of 5 passed`. Exit 0 or 1.
- verb `scripts/launch-check.sh`: new CLI script. Env: `BASE_URL`, `TOCSIN_CLI`, `MCP_URL`, `MAX_AGE_HOURS`.
- format `README.md`: rewritten to the final launch text.
- function `startLocalWorker` (tests/launch/local-worker.tcs-14.ts): new test helper.
- format `vitest.config.ts projects`: new project `launch`; `api` project excludes `tests/launch/**`. callers: left alone: the `api`, `mcp` and `cli` projects keep their includes.

## Tasks

### T0. Make sure the branch serves /v1/status
`test -f src/routes/status.ts || git merge --no-edit origin/main`. No edits to the merged files.
VALIDATE: `test -f src/routes/status.ts && grep -q '"/v1/status"' src/app.ts`
SATISFIES: "`GET /status` shows every source with `last_ok_at` within 24 hours" (the script needs the route to exist in the local worker).

### T1. Write `scripts/launch-check.sh`
- `set -uo pipefail` (no `-e`: every check runs, failures are counted).
- Env with defaults: `BASE_URL=https://tocsin.sh`, `TOCSIN_CLI="npx --yes tocsin@latest"`, `MCP_URL=https://mcp.tocsin.sh/mcp`, `MAX_AGE_HOURS=24`. Strip one trailing `/` from `BASE_URL`.
- Preflight: `curl` and `jq` must be on PATH, else print `FAIL preflight: <tool> not found` and exit 1.
- `get <path>`: `curl -sS --max-time 20 -w '\n%{http_code}'`. A non-200 status, a curl error or a body that is not JSON fails that check with the status in the reason.
- Check 1 `node-cve`: `GET /v1/events/cve/CVE-2026-111497`, pass if `.fixed_versions | index("24.22.1")` is not null.
- Check 2 `php-cve`: `GET /v1/events/cve/CVE-2026-109618`, pass if `.fixed_versions` contains `8.4.27`.
- Check 3 `check-node`: `GET /v1/check?node=24.22.0`, pass if `.affected | length >= 1` and some item has `cve_ids` containing `CVE-2026-111497` and `fixed_in == "24.22.1"` (A3).
- Check 4 `status`: `GET /v1/status`. Fail if `.sources` is empty. For each source, fail if `last_ok_at` is null or older than `MAX_AGE_HOURS`. Parse with jq after `sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601` (D1 stores `toISOString()` with milliseconds; plain `fromdateiso8601` refuses fractions). The reason names every failing source id.
- Check 5 `cli-connect`: `HOME=$(mktemp -d) $TOCSIN_CLI connect --dry-run` with a 120 s `timeout`. Pass if the output contains `MCP_URL` and (`"mcpServers"` or `[mcp_servers.tocsin]`) (A7). Remove the temp dir with a trap.
- Print `ok <check>` / `FAIL <check>: <reason>` per check, then the summary line. Exit 1 if any check failed.
- A header comment states purpose, env vars, and that it is the launch acceptance test.
VALIDATE: `bash -n scripts/launch-check.sh && test -x scripts/launch-check.sh && npm test -- tests/launch/launch-check.tcs-14.test.ts`
SATISFIES: "`scripts/launch-check.sh`: against `https://tocsin.sh`, asserts ... Exit 1 on any failure."

### T2. Write the local worker helper `tests/launch/local-worker.tcs-14.ts`
- `bundleWorker()` (memoized per file): esbuild `build({ entryPoints: ["src/index.ts"], bundle: true, format: "esm", platform: "browser", conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"], write: false })`, one output file.
- `startLocalWorker()`: `new Miniflare({ modules: true, script, compatibilityDate` and `compatibilityFlags` read from `wrangler.toml`, `d1Databases: ["DB"]`, `kvNamespaces: ["CURSORS"]`, `queueProducers: { DELIVERIES: "deliveries" }`, `host: "127.0.0.1"`, `port: 0`, `outboundService })`. Each call gets its own in-memory storage, so tests share no data.
- Apply every `migrations/*.sql` in order through `mf.getD1Database("DB")` (use `readD1Migrations` from `@cloudflare/vitest-pool-workers`, which `vitest.config.ts` already calls in node).
- Seed (A6): `UPDATE sources SET enabled = 0 WHERE id NOT IN ('node-runtime','php-runtime')`, put `NODE_CURSOR_KEY` and `PHP_CURSOR_KEY` = `2026-10-01T00:00:00Z` in KV, then `(await mf.getWorker()).scheduled({ cron: "*/10 * * * *" })`. Poll `SELECT COUNT(*) FROM sources WHERE enabled = 1 AND last_ok_at IS NOT NULL` until it is 2, max 15 s, else throw with each source's `last_error`.
- `outboundService`: reads the 7 fixture files with `fs` and answers by exact URL (the ROUTES map of `tests/cron/runtime-ingest.tcs-6.test.ts`, with the content types the TCS-6 fake uses). Any other URL: response 599, and the URL is pushed to `unknownUrls`.
- Returns `{ url, mf, db, unknownUrls, dispose }`.
VALIDATE: `npm test -- tests/launch/launch-check.tcs-14.test.ts -t L1`
SATISFIES: "runs `scripts/launch-check.sh` against a local worker seeded with the 2026-10-21 fixtures"

### T3. Write the acceptance test `tests/launch/launch-check.tcs-14.test.ts` and the `launch` vitest project
- `vitest.config.ts`: add `{ test: { name: "launch", environment: "node", include: ["tests/launch/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 180_000 } }` and add `"tests/launch/**"` to the `api` project's `exclude`.
- `package.json`: `miniflare` and `esbuild` in `devDependencies` at the versions `npm ls miniflare esbuild` shows for wrangler; run `npm install` to update the lockfile root entries.
- `beforeAll`: compile the CLI once: `npx tsc -p packages/cli/tsconfig.build.json`.
- Each test calls `startLocalWorker()` in `beforeEach` and `dispose()` in `afterEach` (fresh storage per test, no order dependence).
- Run the script with `spawnSync("bash", ["scripts/launch-check.sh"], { env: { ...process.env, BASE_URL: w.url, TOCSIN_CLI: "node packages/cli/bin/tocsin.js" } })`.
- Cases: see Acceptance tests L1 to L6.
VALIDATE: `npm test -- tests/launch/launch-check.tcs-14.test.ts` (all pass) and, before T1 exists, the same command fails (the script is missing).
SATISFIES: "`tests/launch/launch-check.test.ts` runs `scripts/launch-check.sh` against a local worker seeded with the 2026-10-21 fixtures and expects exit 0; with the node advisory removed expects exit 1."

### T4. Nightly CI workflow `.github/workflows/launch-check.yml`
- `on: schedule: cron "17 6 * * *"` and `workflow_dispatch`.
- Job `if: vars.LAUNCH_CHECK_ENABLED == '1' || github.event_name == 'workflow_dispatch'`.
- Steps: checkout, setup-node 22, `bash scripts/launch-check.sh` (default `BASE_URL`, real `npx tocsin@latest`). No secrets needed.
- This is the live run against prod and npm, not PR-path. It never runs on `pull_request`.
VALIDATE: `grep -q 'LAUNCH_CHECK_ENABLED' .github/workflows/launch-check.yml && ! grep -q 'pull_request' .github/workflows/launch-check.yml && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/launch-check.yml'))"`
SATISFIES: "This script is the acceptance test of the launch and runs in CI nightly after launch."

### T5. README final text
Keep the existing "Run locally", "Deploy", "MCP server" and "CLI" sections (they are true). Replace the top:
- Title and one-line pitch.
- The three lines an agent needs (`curl .../v1/events?since=0&ecosystem=node,npm&min_severity=high`, `curl .../v1/check?node=24.22.0&php=8.4.26`, MCP `https://mcp.tocsin.sh/mcp`). Remove "The planned interface (not live yet)" and "Status: scaffold".
- Connect: `npx tocsin connect`.
- Schema link: `https://tocsin.sh/schema/advisory.v1.json` and `schema/advisory.v1.json`.
- Self-host: one line, `npm install && npm run migrate:local && npx wrangler deploy`, pointing at the Deploy section.
- Launch check: one line on `scripts/launch-check.sh`.
- "Built with": "Built with Cromford" linking `https://cromford.ai`, plus the factory sentence.
- "How it was built": short paragraph, link `https://github.com/Fortunian/tocsin/pulls?q=is%3Apr+is%3Amerged`, every PR title carries its TCS key, the PR is the proof.
De-AI voice, no em dashes, STE-plain.
VALIDATE: `grep -q 'cromford.ai' README.md && grep -q 'npx tocsin connect' README.md && grep -q 'wrangler deploy' README.md && grep -q 'schema/advisory.v1.json' README.md && grep -q 'pulls' README.md && ! grep -qi 'not live yet\|Status: scaffold' README.md`
SATISFIES: "`README.md` final: the three lines an agent needs, the connect command, the schema link, the self-host line, a "Built with" section ..., and a short "How it was built" paragraph"

### T6. Launch post `docs/LAUNCH_POST.md`
- Title exactly "Your agent's fetch() was exploitable on October 21 and nothing told it".
- About 400 words (350 to 450), first person, Lior's voice, short sentences, near-zero em dashes, no "It's not X, it's Y".
- Facts, each with a source link: Node CVE-2026-111497 (Brotli decoder out-of-bounds write, high, 22.x/24.x/26.x, fixed 22.23.4, 24.22.1, 26.12.1, link the nodejs.org post) and the fetch link sentence (A9); PHP CVE-2026-109618 and CVE-2026-109619, RCE, CVSS 4.0 score 9.2 (from GHSA-w8hw-w9fx-j79w), fixed in 8.5.12, 8.4.27, 8.3.36, 8.2.35, link the php.net post.
- The connect command `npx tocsin connect` and one check curl.
- Free and paid per A8.
- Cromford once, in one sentence (spec: "The launch post says it once, in one sentence").
- Ends with the open-source link `https://github.com/Fortunian/tocsin`.
- De-AI pass: re-read and strip AI-isms before commit.
VALIDATE: `head -1 docs/LAUNCH_POST.md | grep -qF "Your agent's fetch() was exploitable on October 21 and nothing told it" && w=$(wc -w < docs/LAUNCH_POST.md) && [ $w -ge 350 ] && [ $w -le 470 ] && grep -q CVE-2026-111497 docs/LAUNCH_POST.md && grep -q CVE-2026-109618 docs/LAUNCH_POST.md && grep -q 'npx tocsin connect' docs/LAUNCH_POST.md && tail -3 docs/LAUNCH_POST.md | grep -q 'github.com/Fortunian/tocsin' && [ $(grep -c Cromford docs/LAUNCH_POST.md) -eq 1 ] && [ $(grep -o '—' docs/LAUNCH_POST.md | wc -l) -le 1 ]`
SATISFIES: "`docs/LAUNCH_POST.md`: the launch post in Lior's voice, about 400 words, title ... states the two facts ..., shows the connect command, says what is free and what is paid, and ends with the open-source link. Goes through the De-AI pass"

### T7. Issue template `.github/ISSUE_TEMPLATE/source-request.md`
Front matter: `name: Request a source`, `about: Ask Tocsin to ingest a new ecosystem or advisory source`, `title: "Source request: "`, `labels: source-request`. Body fields: ecosystem or runtime, the advisory source URL, its format (RSS, JSON API, OSV, HTML), how often it publishes, who uses it. No `ai-build` label (the label is the harness handoff and only Lior applies it).
VALIDATE: `head -6 .github/ISSUE_TEMPLATE/source-request.md | grep -q '^name: Request a source' && ! grep -q ai-build .github/ISSUE_TEMPLATE/source-request.md`
SATISFIES: "`.github/ISSUE_TEMPLATE/source-request.md`: "Request a source" template so people can ask for an ecosystem."

### T8. Full verify
VALIDATE: `npm run typecheck && npm run gen:schema -- --check && npm test` all green.
SATISFIES: "Verification contract: npm test, npm run typecheck"

## Edge cases

- `last_ok_at` with milliseconds (`toISOString()`): jq `fromdateiso8601` fails on fractions, so strip them first (T1, test L3).
- A source with `last_ok_at` NULL: fails and is named (L4).
- `BASE_URL` with a trailing slash: stripped.
- `/v1/events/cve/...` 404 (advisory missing): FAIL with "404", not a jq crash (L2).
- A non-JSON body (an HTML error page from a proxy): FAIL with "not JSON".
- The events route is rate limited per IP (`src/middleware/ratelimit.ts`). The script makes 2 events calls and 2 other calls, far under any limit.
- `scheduled` in Miniflare can return before `waitUntil` work ends, so the helper polls `sources` (T2).
- The CLI compile needs `typescript`, already a devDependency.

## Iron laws: how they apply

- Schema, indexes, retention, RLS: no migration, no table, no query on a new table. n/a.
- DB-driven config: the script's thresholds are env knobs with documented defaults (`MAX_AGE_HOURS=24`). It is an operator script, not app config. No hardcoded business value moves into the worker.
- Sortable headers, list-over-cards, drill-down, loading.tsx: no UI. n/a.
- De-AI: README and the launch post are human-facing text. Both get the De-AI pass (T5, T6).
- Model ids: no LLM. n/a.
- Dedup-before-spend: no metered call. The nightly workflow calls tocsin.sh and npm only.
- Scalable tests (BH-7563): the PR-path test makes 0 vendor calls. The worker's outbound fetch goes to the fixture fake; any other URL is recorded and L6 asserts the list is empty. The CLI runs from the local build, not `npx tocsin@latest`. The live prod run lives only in the nightly workflow (rule 4). Each test gets its own Miniflare storage (rule 5).
- Iron rule 10 (published text is a sourced fact): every fact in the post carries a source link; the one inference (A9) is flagged in the PR body.
- Per-ticket test files: both new test files carry `.tcs-14`.

## Build discipline rules that bite

- Surgical: no edit to `src/` or to any TCS-6 file. Stack section is enforced.
- Test-first: L1/L2 fail before T1 (no script), pass after.
- Honest claims: the PR body says the prod gate was NOT run against tocsin.sh from the build box, and that it is expected to FAIL there until #7 ships (A2) and DEPLOY is on.
- No hand-append to a shared index: n/a.

## System invariants

(a) Cross-run state: none. The script is stateless. The test keeps no state between tests (fresh Miniflare per test).
(b) External side effects: the script only reads (GET) and runs a dry-run CLI with a throwaway HOME, so no write anywhere. The nightly workflow reads prod and npm; a failure is a red workflow run and nothing else.
(c) Adversarial negatives for the decision rule (the gate decides "launch ready"): it must NOT pass when the node advisory is missing (L2), when a source is 25 h stale (L3), when a source never succeeded (L4), when the CLI prints no MCP block (L5), when a route 404s or returns HTML. Near misses that must pass: a source 23 h old (L3), a `last_ok_at` with milliseconds (L1).
(d) Neighbors: the `api` vitest project's `include` is `tests/**/*.test.ts`, so `tests/launch/**` must be excluded there or the api pool would try to run a node test in workerd (T3). The nightly workflow does not share the `ci.yml` deploy concurrency group and runs no deploy. The cron lane and the KV rate limiter are untouched.

## Requirements coverage

| Requirement (ticket) | Task | Test / check |
|---|---|---|
| script asserts CVE-2026-111497 fixed 24.22.1 | T1 | L1 ok line `node-cve`; L2 FAIL |
| script asserts CVE-2026-109618 fixed 8.4.27 | T1 | L1 ok line `php-cve` |
| `/v1/check?node=24.22.0` returns an affected item | T1 (A3) | L1 ok `check-node`; L2 FAIL `check-node` |
| every source `last_ok_at` within 24 h | T0, T1 | L1, L3 (23 h ok, 25 h FAIL), L4 (NULL FAIL) |
| `npx tocsin@latest connect --dry-run` prints the MCP block | T1 | L1 ok `cli-connect`; L5 FAIL |
| exit 1 on any failure | T1 | L2, L3, L4, L5 |
| runs in CI nightly after launch | T4 | T4 VALIDATE |
| test: seeded local worker, exit 0; node advisory removed, exit 1 | T2, T3 | L1, L2 |
| README final (3 lines, connect, schema, self-host, Built with, How it was built) | T5 | T5 VALIDATE |
| launch post (title, ~400 words, two facts, connect, free/paid, OSS link, De-AI) | T6 | T6 VALIDATE |
| Request a source template | T7 | T7 VALIDATE |
| title: "public repo" | none (operator action) | NEEDS_HUMAN at go-live: Lior sets Fortunian/tocsin public. Not a code change. |
| title: "real advisories in prod" | none on this box | Run `bash scripts/launch-check.sh` against tocsin.sh after deploy. Not run here (A2, prod expected red until #7). |
| negative: out of scope Stripe, ads, newsletter | none | no file under billing; diff review |
| negative: no PR-path vendor call | T2, T3 | L6 (`unknownUrls` empty; CLI from local build) |

## Acceptance tests

File `tests/launch/launch-check.tcs-14.test.ts` (vitest project `launch`, node environment). Each case boots its own seeded worker.

- L1: seeded worker, `TOCSIN_CLI=node packages/cli/bin/tocsin.js`. Script exit 0. stdout has `ok node-cve`, `ok php-cve`, `ok check-node`, `ok status`, `ok cli-connect` and `launch-check: 5 of 5 passed`.
- L2: node advisory removed (`DELETE FROM advisory_sources WHERE advisory_id IN (SELECT id FROM advisories WHERE cve_primary = 'CVE-2026-111497')`, then the same on `advisories`). Script exit 1. stdout has `FAIL node-cve` and `FAIL check-node`, and `ok php-cve`.
- L3: `UPDATE sources SET last_ok_at = <now - 25 h ISO with ms> WHERE id = 'php-runtime'`. Exit 1, `FAIL status` naming `php-runtime` and not `node-runtime`. Same with now - 23 h: exit 0.
- L4: `UPDATE sources SET last_ok_at = NULL WHERE id = 'node-runtime'`. Exit 1, `FAIL status` names `node-runtime`.
- L5: `TOCSIN_CLI` set to `node -e "console.log('hello')"`. Exit 1, `FAIL cli-connect`, the four HTTP checks `ok`.
- L6: after L1's run, the helper's `unknownUrls` is empty (0 vendor calls; budget test).

Before the change: L1 to L5 fail (no `scripts/launch-check.sh`). After: all pass.

Regression risk: `tests/cron/runtime-ingest.tcs-6.test.ts` and every `api` project suite (the `api` exclude list changes in `vitest.config.ts`). `npm test` runs all of them in T8.

## QA screens

No UI changes. Screens a browser QA pass can read after deploy (no new flow):
- `https://tocsin.sh/status`: every source row shows a recent last OK time (the gate's check 4 in HTML form).
- `https://github.com/Fortunian/tocsin` README renders the new sections and the cromford.ai link.
- `https://github.com/Fortunian/tocsin/issues/new/choose` lists "Request a source".

## Failure modes

This plan changes no path under `bin/` or `worker/`. Section not required.

## Sibling claims (not touched)

`/root/harness/state/claims/tocsin/` is empty at plan time. No sibling build.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section (copied verbatim)
not run against https://tocsin.sh <- Honest claims: prod gate not run from the build box
CVE-2026-111497 <- A9: the fetch() link sentence flagged for Lior's read
```

KIND: infra

## Design collision check (BH-5791)

Checked 5 listed and 0 derived symbols against main ae804eb56058..ae804eb56058 and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 4
LINES: 180
DIFF_KB: 40

SIZE: M
