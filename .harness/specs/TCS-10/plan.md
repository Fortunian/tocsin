# TCS-10 plan (round r2, resume): tocsin.sh site (landing with the exact copy, /docs, /status, /v1/status, tocsin.so redirect)

Issue: Fortunian/tocsin#10. Blocked-by #3 is CLOSED. Open PRs on the repo: none. No PR for TCS-10 exists.

ALREADY ON MAIN? No. `git log origin/main --since=2026-10-22T00:26:54Z -- src/app.ts site docs/API.md src/routes/status.ts`
shows TCS-3/9/12/13 only. None of them adds `/`, `/docs`, `/status`, `/v1/status`, `site/`, `docs/API.md` or a tocsin.so redirect.
origin/main is 86ad46b, which is the merge base of this branch (0 commits past the fork).

## Where this round starts

The branch `ticket/tcs-10-r2` carries 2 checkpoint commits from build tocsin-TCS-10-202610221541 (16d85bf, 9bb3634).
That build implemented the accepted plan in full. Its EXECUTE ended EXECUTE_EMPTY for two reasons only:
the session made no commit of its own, and its T7 `npm test` run was killed with rc 137 (memory) on a busy box.

I re-checked the checkpoint tree at plan time (2026-10-22 17:03Z, on this worktree at 9bb3634):
- `npm run typecheck`: exit 0.
- `npx vitest run` (full suite, all 3 projects): 26 files, 441 tests, exit 0. The rc 137 did not repeat.
- `npx vitest run tests/routes/site.tcs-10.test.ts tests/routes/site-plan.tcs-10.test.ts tests/worker/migrations.tcs-1.test.ts`: 25 passed.
- `npm run gen:docs -- --check`: up to date. `npm run gen:schema -- --check`: up to date.
- The previous round's evidence: Playwright e2e 5/5 passed (`e2e.txt`), D7 render of `/`, `/docs`, `/status`, `/v1/status` and the
  tocsin.so 301 on an empty local DB (`d7-render.txt`), 8 mutations each turned a test red (`mutation.txt`).

So this round does NOT rebuild. It keeps the checkpoint tree, re-runs every VALIDATE, fixes only what is red, and makes the
build's own commit. The design below is the accepted design of round 202610221541, unchanged.

CodeGraph is not available on this box. The file set comes from reading `src/app.ts`, `src/routes/*.ts`, `src/feed/query.ts`,
`src/lib/settings.ts`, `migrations/*`, `vitest.config.ts`, `tsconfig.json`, `.github/workflows/ci.yml` and the checkpoint diff.
No verification map in this repo (primer: ABSENT).

## Spec changes from comments

Newest first. The thread has one comment.

- 6329994269 — liorwn (2026-10-22T00:53Z): "launch is free, no paid tier". The pricing lines are replaced by one line
  `Free. No account to read. An API key (free) for watch lists and signed webhooks.` No pricing or billing page.
  The issue body already carries this text. Delivered by T3 (copy verbatim). Pinned by site.tcs-10 test 3 (line present,
  no pricing strings, `GET /pricing` is 404).

## Scope

1. `GET /` (any host except tocsin.so): one worker-rendered HTML page with the exact landing copy, inline CSS
   (system font stack, dark background, one accent color), one inline copy-button script, and a live "Latest"
   table (10 newest advisories; columns when, component, CVE, severity, action) read from D1, cached 60 s in KV.
2. `GET /docs`: one HTML page generated from `docs/API.md`.
3. `GET /status`: HTML with per-source `last_ok_at` and `last_error` from `sources`, plus the newest cursor.
   `GET /v1/status`: the same data as JSON `{ sources: [...], cursor }`.
4. Any request with host `tocsin.so` or `www.tocsin.so` answers 301 to `https://tocsin.sh<path><query>`.
5. README: `## Built with` heading with the Cromford line.
6. Playwright `tests/e2e/site.spec.ts`: 1440/375 no horizontal scroll; clipboard copy button.

Out of scope (ticket): sign-up UI, dashboard, pricing or billing page, analytics scripts.

## ASSUMPTIONS

- A1 "Static site in `site/` ... Workers static assets" vs. "Latest table is rendered in the worker from D1": the
  landing needs live D1 data and tocsin.so needs a worker redirect, so every page is worker-rendered. `site/` holds
  the page templates as TypeScript modules (string templates with inline CSS/JS). No `[assets]` binding in
  `wrangler.toml`. Other reading: `[assets] directory="site/public"` with `run_worker_first`; rejected because no
  file on the page is static (no external assets allowed) and it adds deploy config with no user-visible gain.
- A2 "10 rows from /v1/events?limit=10" under the heading "Latest": `/v1/events?limit=10` with the default `order=asc`
  returns the 10 OLDEST rows. The table shows the 10 NEWEST (the same `buildEventsQuery`, `order: "desc"`, which is
  `/v1/events?limit=10&order=desc`). Other reading: oldest 10; rejected because "Latest" over the oldest rows is wrong data.
- A3 Columns: when = `published_at` as `YYYY-MM-DD` inside `<time datetime="<full ISO>">`; component =
  `ecosystem/component`; CVE = `cve_ids[0]`, or `-` when none (GHSA-only advisories); severity = `severity.label`;
  action = the advisory's `action` string. The component cell links to `/v1/events/<id>`; the CVE cell links to
  `/v1/events/cve/<cve>` (no dead identity cells).
- A4 `github.com/<org>/tocsin` = `github.com/Fortunian/tocsin` (CLAUDE.md "Repo: Fortunian/tocsin"). Visible text
  `github.com/Fortunian/tocsin`, link `https://github.com/Fortunian/tocsin`.
- A5 "Built with Cromford." renders as `<a href="https://cromford.ai">Built with Cromford</a>.` with no `rel`
  attribute, so the HTML holds the literal acceptance string and the link. Other reading: link only "Cromford";
  rejected because the tag would split the literal `Built with Cromford`.
- A6 `/status` and `/v1/status` list ENABLED sources only (`WHERE enabled = 1`, the acceptance line says "every
  enabled source"). JSON: `{ "sources": [{ "id", "kind", "last_run_at", "last_ok_at", "last_error" }], "cursor": <int> }`.
  `cursor` = `MAX(cursor)`, `0` when no advisory exists (0 is the feed's own start value for `since=`).
- A7 Redirect hosts: exactly `tocsin.so` and `www.tocsin.so`, case-insensitive, port ignored, query kept.
  `wrangler.toml` is NOT changed: a route on a zone the account lacks fails `wrangler deploy`. The PR body carries
  the operator step (add the `tocsin.so` zone and a route or custom domain for the `tocsin` worker).
- A8 Rule 5 (limits are DB rows): row count and cache TTL are settings rows `site.latest_rows` (10) and
  `site.latest_cache_seconds` (60) in migration `0006_site_settings.sql`; code constants are documented fallbacks.
  They are read ONLY on a KV miss. KV rejects a TTL below 60 s, so a value below 60 falls back to 60 with one log line;
  rows outside 1..100 fall back to 10 with one log line.
- A9 `/docs` is generated at build time, the same pattern as `gen:schema`: `scripts/gen-docs.mjs` turns `docs/API.md`
  into `site/docs.generated.ts`; `--check` exits 1 when the committed file is stale; CI runs it. Other reading: render
  at request time; rejected because it needs a Text-module rule in wrangler and in the vitest pool.
- A10 `docs/API.md` states only what is on main. Webhooks (signature) and watch lists / API keys are not built: that
  section gives the planned header format under the line "Not live yet." Whether the npm package is published is not stated.
- A11 Sortable table headers (iron law) vs. "no JavaScript except the copy buttons" (ticket): the ticket wins. The
  Latest table is fixed newest-first, 10 rows; the status table holds 6 or fewer sources. No sort controls.
- A12 Playwright is not wired into CI (`npm test` stays vitest only; CI downloads no browser). The spec runs with
  `npm run test:e2e`. If the box cannot run chromium, the build records `[NOTE] not verified here: Playwright e2e`.
- A13 `/status` and `/v1/status` are not cached and not rate-limited: 1 `db.batch` of 2 cheap statements.
  `Cache-Control: no-cache` on status; `public, max-age=60` on `/` and `/docs`.
- A14 The ticket names the acceptance file `tests/routes/site.test.ts`; the harness per-ticket rule makes it
  `tests/routes/site.tcs-10.test.ts`. The Playwright file keeps the ticket's name `tests/e2e/site.spec.ts`.
- A15 README "Status: scaffold. Only `GET /v1/health` is live in code." was stale; it is replaced by one line that points at `https://tocsin.sh/status`.
- A16 (this round) The checkpoint tree is the build. The executor does not rewrite files that pass their VALIDATE. If a
  VALIDATE is red, it fixes that file only. Other reading: rebuild from main; rejected because it repeats a passing build.

## Files to touch

All already exist on the branch (checkpoints 16d85bf, 9bb3634). This round edits one only when its VALIDATE is red.

Create:
- `src/routes/site.ts`
- `src/routes/status.ts`
- `src/site/data.ts`
- `src/site/redirect.ts`
- `site/layout.ts`
- `site/landing.ts`
- `site/status.ts`
- `site/docs.ts`
- `site/docs.generated.ts`
- `scripts/gen-docs.mjs`
- `migrations/0006_site_settings.sql`
- `docs/API.md`
- `playwright.config.ts`
- `tests/routes/site.tcs-10.test.ts`
- `tests/routes/site-plan.tcs-10.test.ts`
- `tests/e2e/site.spec.ts`

Modify:
- `src/app.ts`
- `package.json`
- `package-lock.json`
- `.github/workflows/ci.yml`
- `.gitignore`
- `tsconfig.json`
- `README.md`
- `docs/RETENTION.md`
- `tests/worker/migrations.tcs-1.test.ts`

## Tests that must change

- `tests/worker/migrations.tcs-1.test.ts`: the test "applies 0001..0005" pins the exact migration list; this ticket adds `0006_site_settings.sql`, so the expected list (and the test name) gains it. Nothing else in that file changes.

## Changed symbols

- function `app` (default export of `src/app.ts`): gains `soRedirect` ahead of `cors` and two mounts (`/v1/status`, `/` site). callers: left alone: `src/index.ts` passes `app.fetch` through unchanged.
- route `GET /`: new, landing HTML.
- route `GET /docs`: new, docs HTML.
- route `GET /status`: new, status HTML.
- route `GET /v1/status`: new, JSON `{ sources[], cursor }`.
- route `ANY <host tocsin.so>/*`: new, 301 to `https://tocsin.sh` + path + query.
- verb `npm run gen:docs`: new package script.
- verb `npm run test:e2e`: new package script.
- format `site/docs.generated.ts`: new generated module (writer `scripts/gen-docs.mjs`, reader `site/docs.ts`).
- format KV key `site:latest:v1` in the `CURSORS` namespace: JSON array of row objects, TTL from settings (writer and reader: `src/site/data.ts`).

## Sibling claims (not touched)

`/root/harness/state/claims/tocsin/` is empty at plan time. No sibling build is running.

## Tasks

Order: T0 first. T1-T7 are re-validation of the checkpoint tree (light, vitest). T8 (browser) next. T9 commits last.

### T0 Adopt the checkpoint tree
Confirm HEAD is 9bb3634 or a descendant on `ticket/tcs-10-r2`, the tree is clean, and `test-results/` is ignored (9bb3634 removed the committed `.last-run.json`).
Do not reset to main. Do not re-create files.
VALIDATE: git merge-base --is-ancestor 9bb3634 HEAD && test -z "$(git status --porcelain)" && ! git ls-files --error-unmatch test-results/.last-run.json 2>/dev/null
SATISFIES: every ticket line below; this task keeps the delivered tree instead of rebuilding it (A16).

### T1 Redirect middleware and app wiring
`src/site/redirect.ts`: `soRedirect` lowercases `URL.hostname`; `tocsin.so` or `www.tocsin.so` returns
`c.redirect("https://tocsin.sh" + pathname + search, 301)`; else `next()`. `src/app.ts`: `soRedirect` is the FIRST
middleware; `app.route("/v1/status", status)`; `app.route("/", site)` after `discovery`. JSON `notFound` and `onError` stay.
VALIDATE: npx vitest run tests/routes/site.tcs-10.test.ts -t "tocsin.so"
SATISFIES: "`tocsin.so` redirects 301 to `tocsin.sh` with the path preserved."

### T2 Status loader, `/v1/status` JSON and `/status` HTML
`loadStatus(db)`: one `db.batch` of `STATUS_SOURCES_SQL` (`WHERE enabled = 1 ORDER BY id`) and `STATUS_CURSOR_SQL`
(`MAX(cursor)`). `/v1/status` via `jsonUtf8`, `Cache-Control: no-cache`. `site/status.ts` renders an escaped table and `Newest cursor: <n>`.
VALIDATE: npx vitest run tests/routes/site.tcs-10.test.ts -t "status"
SATISFIES: "`/status`: per-source `last_ok_at` and `last_error` from the `sources` table, plus the newest cursor. Also JSON at `/v1/status`."

### T3 Landing page with the exact copy and the copy buttons
`site/layout.ts` (shell, inline CSS, `escapeHtml`, one inline copy script, footer `docs · status · llms.txt`) and
`site/landing.ts` (the issue's copy block verbatim, in order, with the comment-6329994269 line; copy buttons next to
`npx tocsin connect` and each by-hand command). No `<link>`, no `<script src=`.
VALIDATE: npx vitest run tests/routes/site.tcs-10.test.ts -t "landing"
SATISFIES: "One page. System font stack, no external assets, no JavaScript except the copy buttons. Dark background, one accent color." and "The copy below is final and ships as written."

### T4 Latest table: D1 read, KV cache, settings rows
`migrations/0006_site_settings.sql` (two `INSERT OR IGNORE` settings rows). `loadLatest(env)`: KV get first; on a miss
`Promise.all` of the 2 settings, `buildEventsQuery({... order: "desc"})`, map to rows, KV put with the TTL; a D1 error returns
`null` and caches nothing. `renderLanding(null)` and `renderLanding([])` print different lines.
VALIDATE: npx vitest run tests/routes/site.tcs-10.test.ts -t "Latest" && npx vitest run tests/routes/site-plan.tcs-10.test.ts tests/worker/migrations.tcs-1.test.ts
SATISFIES: "[live table: 10 rows from /v1/events?limit=10, columns: when, component, CVE, severity, action]" and "Latest table is rendered in the worker from D1, cached 60 seconds in KV."

### T5 docs/API.md and the generated /docs page
`docs/API.md` (endpoints, schema, cursor rule, rate limits, webhook signature marked "Not live yet.", the connect command);
`scripts/gen-docs.mjs` writes `site/docs.generated.ts`; `--check` exits 1 when stale; CI step `npm run gen:docs -- --check`.
VALIDATE: npm run gen:docs -- --check && npx vitest run tests/routes/site.tcs-10.test.ts -t "docs"
SATISFIES: "`/docs`: one page generated from `docs/API.md` (endpoints, schema, cursor rule, rate limits, webhook signature, the connect command)."

### T6 README "Built with" and retention doc
VALIDATE: grep -n "^## Built with" README.md && grep -n "Built with \[Cromford\](https://cromford.ai)" README.md && grep -n "site:latest" docs/RETENTION.md
SATISFIES: "The repo README gets the same line under a \"Built with\" heading."

### T7 Acceptance tests, full suite, typecheck
Run the suite. If a run is killed with rc 137 (memory), re-run it once per project (`--project api`, `--project mcp`,
`--project cli`) and record both outputs; a kill is a box limit, not a test result. Do not loop on it.
VALIDATE: npm run typecheck && npm run gen:schema -- --check && (npm test || (npx vitest run --project api && npx vitest run --project mcp && npx vitest run --project cli))
SATISFIES: the ticket's acceptance list "`tests/routes/site.test.ts`: `GET /` returns 200 HTML containing ... no `<link href=\"http`."

### T8 Playwright e2e
`playwright.config.ts` and `tests/e2e/site.spec.ts` exist. Re-run them. If chromium is not available, record
`[NOTE] not verified here: Playwright e2e` and cite the previous round's `e2e.txt` (5 passed).
VALIDATE: npx playwright install chromium && npm run test:e2e
SATISFIES: "Playwright `tests/e2e/site.spec.ts`: landing renders at 1440 and 375 with `document.documentElement.scrollWidth <= window.innerWidth`; the copy button next to `npx tocsin connect` writes it to the clipboard." and "Mobile at 375px with no horizontal scroll."

### T9 The build's own commit
Make one commit on `ticket/tcs-10-r2` with the message `TCS-10: tocsin.sh site: landing with the exact copy, docs, status` and the
attribution footer. If T1-T8 needed no edit, the commit is `git commit --allow-empty` so that the execute stage has a commit of its own
over the checkpoints. Do not squash or rewrite the pushed checkpoint commits.
VALIDATE: git log -1 --format=%s | grep -q "^TCS-10:" && test -z "$(git status --porcelain)" && git diff --stat origin/main...HEAD | tail -1
SATISFIES: the ticket's delivery as one PR on one branch (ticket body "Verification contract": `npm test`, `npm run typecheck`).

## Iron laws: how they apply

- Sortable headers: not applied; the ticket forbids JS beyond copy buttons (A11).
- List over cards: both data views are plain tables.
- Drill-down / no dead rows: Latest cells link to `/v1/events/<id>` and `/v1/events/cve/<cve>`. Status rows are sources; no detail view exists.
- DB-driven config: `site.latest_rows`, `site.latest_cache_seconds` settings rows, code constants as fallbacks (A8).
- RLS: D1, not Supabase; no new table.
- Indexes / EXPLAIN: no new table. Latest (`ORDER BY cursor DESC LIMIT n`) and `MAX(cursor)` use `idx_advisories_cursor`; pinned in `site-plan.tcs-10.test.ts` on 2 000 seeded rows. `sources` is a fixed 6-row table.
- No correlated subquery.
- Retention: no new growing table. The KV key expires by TTL (`docs/RETENTION.md`). Settings rows are 2 fixed keys.
- De-AI: no LLM. Copy is the client's verbatim text.
- Dedup-before-spend: no metered call.
- Native dialogs: none.
- Mobile 375: `pre` and tables scroll inside `overflow-x:auto`; pinned by T8.
- CLAUDE.md rule 10: each Latest row links to the advisory JSON, which carries `sources[].url`.
- XSS: every DB string goes through `escapeHtml` (test 10, mutation `no-escape` turns it red).
- Scalable tests: no vendor touched; no seam, fake or contract test needed. Tests seed unique ids and do not depend on order.

## Build-discipline rules that bite

- D2: every acceptance test goes through `exports.default.fetch` (`src/index.ts` → `app`).
- D1 mutation checks: already run in round 202610221541 (8 mutations, each red). Re-run only if a file in T1-T4 changes.
- D5 / D26: docs never state webhooks or watch lists as live (A10). Only real URLs: `tocsin.sh`, `mcp.tocsin.sh`, `cromford.ai`, `github.com/Fortunian/tocsin`.
- D7: render `/`, `/docs`, `/status` once on an empty local DB. Done in round 202610221541 (`d7-render.txt`); re-run if a site file changes.
- D9 / D13: a D1 failure renders "Latest is not available right now.", never "No advisories yet."; a failure is never cached.
- D11: `cursor` is 0 only when `MAX` is NULL; out-of-range settings log and fall back.
- D8: operator steps (tocsin.so zone + route; `npx playwright install chromium` for e2e) ride in the PR body.
- Claim discipline: a killed test run is reported as killed, never as passed.

## Performance (BH-6946)

- `/` KV hit: 1 KV get, 0 D1 statements. KV miss: 2 settings reads in parallel (`Promise.all`), then 1 advisories statement (`idx_advisories_cursor`), then 1 KV put. 3 D1 statements.
- `/status`, `/v1/status`: 1 `db.batch` round trip, 2 statements (sources; MAX cursor on `idx_advisories_cursor`).
- `/docs`: 0 reads (constant string).
- Payload: Latest 10 rows (bounded 1..100); status 6 rows or fewer. No unbounded list.
- Loading skeleton: n/a. Server-rendered HTML with no client fetch; a Hono worker has no `loading.tsx`.

## System invariants

(a) Cross-run state: one KV key `site:latest:v1` (a cache with TTL, not a dedup, watermark or claim; losing it costs one
D1 read). Settings live in the existing `settings` table (natural key `key`).
(b) Side effects: only the KV put. Success: key written with TTL. Put failure: logged, page renders from D1 rows. D1
failure: "not available" line, no KV write.
(c) Redirect host matcher (client-visible 301). Must NOT redirect: `tocsin.sh`, `www.tocsin.sh`, `mcp.tocsin.sh`,
`notocsin.so`, `tocsin.so.example.com`, `tocsin.sol`, `tocsin.test`, `localhost`. Must redirect: `tocsin.so`,
`TOCSIN.SO`, `www.tocsin.so`, `tocsin.so:443`. Test 14 includes every one.
(d) Neighbors: the `*/10` cron writes `sources.last_*` and advisories; this change only reads them. The rate limiter is
mounted on `/v1/events` and `/v1/check` only; the new routes do not pass it and do not touch its `rl:` keys. Discovery owns
`/llms.txt`, `/.well-known/*`, `/schema/*`; the site router registers only `/`, `/docs`, `/status` (no wildcard). JSON
`notFound` stays. The MCP worker and CLI call the API over HTTP and never hit these routes. `soRedirect` runs before `cors`;
for other hosts it only calls `next()`.

## Requirements coverage

| Requirement (ticket/thread) | Task | Test |
|---|---|---|
| `GET /` 200 HTML with `npx tocsin connect`, `Security advisories, built for agents.`, `Built with Cromford` | T3 | site.tcs-10 #1 |
| Landing copy verbatim, in order | T3 | site.tcs-10 #2 |
| Free line (comment 6329994269); NO pricing lines | T3 | site.tcs-10 #3 |
| No pricing/billing page (negative) | T1 | site.tcs-10 #3: `GET /pricing` → 404 |
| System font stack, no external assets | T3 | site.tcs-10 #4 |
| No JS except copy buttons | T3 | site.tcs-10 #4: exactly one `<script>`, it references `data-copy` |
| Dark background, one accent color | T3 | QA screen check; `[NOTE]` not machine-pinned |
| Mobile 375 no horizontal scroll | T3, T8 | site.spec.ts 375 |
| Copy button next to `npx tocsin connect` copies it | T3, T8 | site.spec.ts clipboard; site.tcs-10 #5 |
| Latest: 10 rows, columns when/component/CVE/severity/action | T4 | site.tcs-10 #7, #9 |
| Latest from D1, cached 60 s in KV | T4 | site.tcs-10 #8 |
| Advisory text escaped | T4 | site.tcs-10 #10 |
| `/docs` generated from docs/API.md | T5 | site.tcs-10 #15; `gen:docs --check` |
| `/status` per-source last_ok_at/last_error + newest cursor | T2 | site.tcs-10 #12 |
| `/v1/status` JSON `sources[]` + `cursor` | T2 | site.tcs-10 #13 |
| tocsin.so → 301 `https://tocsin.sh/<path>` | T1 | site.tcs-10 #14 |
| Cromford link https://cromford.ai, no rel=nofollow | T3 | site.tcs-10 #6 |
| README "Built with" heading + line | T6 | T6 VALIDATE grep |
| Footer `docs · status · llms.txt` | T3 | site.tcs-10 #6 |
| Out of scope: sign-up, dashboard, analytics (negative) | — | site.tcs-10 #4 (no `<script src=`); #3 no pricing route |
| `npm test` and `npm run typecheck` pass (ticket verification contract) | T7 | full suite + typecheck |

## Acceptance tests

`tests/routes/site.tcs-10.test.ts` (vitest, `@cloudflare/vitest-pool-workers`, `exports.default.fetch`), present on the branch:
1. landing exact strings: `GET /` → 200, `text/html`, body has `npx tocsin connect`, `Security advisories, built for agents.`, `Built with Cromford`.
2. landing copy order: each non-placeholder line of the issue's copy block appears in order.
3. free line, no pricing: has the comment-6329994269 line; no match for `/pricing|\/mo\b|Pro plan/i`; `GET /pricing` → 404.
4. no external assets: no `<script src=`, no `<link href="http`, no `url(http`, no `@import`; exactly one `<script>` tag.
5. copy button: a `button` with `data-copy="npx tocsin connect"`.
6. Cromford anchor `href="https://cromford.ai"` with no `rel=`; footer hrefs `/docs`, `/status`, `/llms.txt`.
7. Latest shows newest N with the five column headers and a `/v1/events/<id>` link.
8. Latest cache: KV key set after a GET; a newer row is hidden until the key is deleted.
9. Latest uses the `site.latest_rows` setting.
10. escapes advisory text.
11. empty and failure states render different lines.
12. `/status` lists every enabled source with `last_ok_at`, `last_error`, `Newest cursor`; not a disabled one.
13. `/v1/status` JSON: `sources[]` with `id`, `last_ok_at`, `last_error`; `cursor` equals the max seeded cursor.
14. tocsin.so redirect: positives and negatives from System invariants (c).
15. `/docs`: `Cursor rule`, `Rate limits`, `Webhook signature`, `npx tocsin connect`, `/v1/status`; no `<script src=`.
16. existing routes unchanged: `/llms.txt` 200 text; an unknown path JSON 404.

`tests/routes/site-plan.tcs-10.test.ts`: 2 000 seeded advisories; EXPLAIN QUERY PLAN of the Latest SQL and of `MAX(cursor)` use `idx_advisories_cursor`, no plain `SCAN advisories`, no temp B-tree.

`tests/e2e/site.spec.ts` (Playwright): `/` at 1440x900 and 375x812 has `scrollWidth <= innerWidth`; copy button writes `npx tocsin connect` to the clipboard; `/status` and `/docs` at 375 have no horizontal scroll.

Regression risk: `tests/routes/discovery.tcs-3.test.ts`, `discovery.tcs-12.test.ts` (shared `/` mount);
`tests/worker/health.tcs-1.test.ts` (app wiring); `tests/worker/migrations.tcs-1.test.ts` (changed, see above);
`tests/routes/events*.tcs-3/12.test.ts`, `ratelimit.tcs-3.test.ts`, `check*.tcs-9.test.ts` (middleware order). All green at plan time (441/441).

## Verify (run, not edited)

- `npm test`
- `npm run typecheck`
- `npm run gen:schema -- --check`
- `npm run gen:docs -- --check`
- `npm run migrate:local && npm run dev`, then `curl -s localhost:8787/`, `/docs`, `/status`, `/v1/status`, and `curl -sI -H 'Host: tocsin.so' localhost:8787/x?y=1`
- `npx playwright install chromium && npm run test:e2e`

## QA screens

- `/` — read the copy top to bottom against the issue; press the copy button next to `npx tocsin connect` and paste; click a Latest component link and CVE link (advisory JSON opens); at 375 px no horizontal scroll, curl lines scroll inside their block.
- `/docs` — renders from API.md; headings for endpoints, schema, cursor rule, rate limits, webhook signature, connect; 375 px no body scroll.
- `/status` — one row per enabled source with last ok and last error; newest cursor line; 375 px no body scroll.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section (copied verbatim)
tocsin.so <- A7 operator step: add the tocsin.so zone and a route or custom domain for the tocsin worker
npx playwright install chromium <- A12 / T8 e2e is not in CI
TEST-CHANGE: <- Tests that must change: tests/worker/migrations.tcs-1.test.ts
```

## Design collision check (BH-5791)

Checked 10 listed and 0 derived symbols against main 86ad46bc9ba2..86ad46bc9ba2 and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size

FILES: 16
LINES: 466
DIFF_KB: 63

KIND: feature
SIZE: M
