# TCS-101 plan: per-repo README badge fed by the GitHub Action (OIDC-signed reports)

Issue #101, filed 2026-10-25T16:07:03Z. State: OPEN, label `ai-build`, 0 comments. The issue body is the spec.

ALREADY ON MAIN? No. `git log origin/main --since=2026-10-25T16:07:03Z` shows only d537d5d (TCS-100, plugin). `git log origin/main -S action_reports` is empty. There are no open PRs on Fortunian/tocsin.

CodeGraph is not available on this box. File sets come from grep and reads, cited per file below.

## Spec changes from comments

none

## Scope

1. Migration `0032_action_reports.sql`: table `action_reports`, its 4 indexes, 7 settings rows.
2. `src/lib/github-oidc.ts`: the one GitHub OIDC seam. It verifies an RS256 JWT against GitHub's JWKS (cached in KV). It has a test-mode fake transport.
3. `POST /v1/action/report` (`src/routes/action-report.ts`): OIDC auth, repo binding, idempotent insert on run_id.
4. `GET /badge/:owner/:repo.svg` (`src/routes/badge-repo.ts`), with `?ref=`. A deterministic SVG, edge cache through the Cache API, and `unknown` when no report exists.
5. Daily retention job `src/cron/action-reports-retention.ts`, run from the existing `41 4 * * *` cron.
6. The Action: input `report` (default `true`). `check.mjs` posts the report after a check result when `id-token: write` is granted. A report error is a warning and does not change the exit code.
7. Docs: new `action/README.md`, the badge snippet in `README.md` and `docs/API.md`, `docs/RETENTION.md`, and `site/docs.generated.ts` from `npm run gen:docs`. `/docs` renders `docs/API.md`, so `/docs` shows the snippet.

## Files to touch

Product code:
- `migrations/0032_action_reports.sql` (new)
- `src/lib/github-oidc.ts` (new): the OIDC seam.
- `src/routes/action-report.ts` (new)
- `src/routes/badge-repo.ts` (new)
- `src/cron/action-reports-retention.ts` (new)
- `site/badge.ts` (new): `flatBadge(label, value, color, title)`, taken out of `renderBadge`.
- `site/freshness.ts`: `renderBadge` calls `flatBadge`. The output stays byte-identical, and `tests/routes/site-freshness.tcs-35.test.ts` pins it.
- `src/app.ts`: mounts the 2 routes. It is the only router (grep `app.route`).
- `src/cron/run.ts`: adds `runActionReportRetention` to the `DELIVERY_RETENTION_CRON` `Promise.allSettled` list (one line).
- `src/env.ts`: optional `GITHUB_OIDC_TRANSPORT?: string`.
- `action/check.mjs`: `readInputs` gets `report`, a new `postReport`, and `finish` calls it.
- `action/action.yml`: input `report` and env `TOCSIN_REPORT`.
- `vitest.config.ts`: the api project binding `GITHUB_OIDC_TRANSPORT: "fake"` (one line).
- `.github/workflows/mail-contract.yml`: two `pull_request.paths` lines (`src/lib/github-oidc.ts` and the new contract test). `npm run test:contract` already runs all of `tests/contract/**` on main and nightly.

Docs and generated files:
- `action/README.md` (new), `README.md`, `docs/API.md`, `site/docs.generated.ts` (output of `npm run gen:docs`, never edited by hand), `docs/RETENTION.md` (repo convention: one section per table, plus the settings row list).

Tests (new, per-ticket):
- `tests/routes/action-report.tcs-101.test.ts`
- `tests/routes/badge-repo.tcs-101.test.ts`
- `tests/routes/action-report-plan.tcs-101.test.ts` (EXPLAIN QUERY PLAN, seeded volume)
- `tests/unit/github-oidc.tcs-101.test.ts`
- `tests/cron/action-reports-retention.tcs-101.test.ts`
- `tests/action/report.tcs-101.test.ts`
- `tests/routes/docs-badge.tcs-101.test.ts`
- `tests/contract/github-oidc.contract.tcs-101.test.ts`
- `tests/routes/oidc-helpers.tcs-101.ts` (test helper: makes an RSA key pair with WebCrypto, signs a JWT and seeds the JWKS into KV)

Tests of other tickets (see "Tests that must change"):
- `tests/worker/migrations.tcs-1.test.ts`
- `tests/action/action-yml.tcs-33.test.ts`

## Tests that must change

- `tests/worker/migrations.tcs-1.test.ts`: the exact list of migration files gets `0032_action_reports.sql`.
- `tests/action/action-yml.tcs-33.test.ts`: the exact `INPUTS` map of action.yml gets `report: ["true", "TOCSIN_REPORT"]`.

```pr-body-requires
TEST-CHANGE: tests/worker/migrations.tcs-1.test.ts <- Tests that must change
TEST-CHANGE: tests/action/action-yml.tcs-33.test.ts <- Tests that must change
## ASSUMPTIONS <- ASSUMPTIONS section (copied verbatim)
```

## Sibling claims (not touched)

`/root/harness/state/claims/tocsin/` is empty. No sibling build is running.

## Design

### Table (migration 0032)

```sql
CREATE TABLE IF NOT EXISTS action_reports (
  id INTEGER PRIMARY KEY,          -- arrival order; with server-set reported_at, id order = reported_at order
  owner TEXT NOT NULL,             -- lowercased, from the token claim
  repo TEXT NOT NULL,              -- lowercased, from the token claim
  ref TEXT NOT NULL,               -- token claim `ref`, for example refs/heads/main
  is_default INTEGER NOT NULL,     -- 1 when ref = 'refs/heads/' || default_branch the Action reported
  is_latest INTEGER NOT NULL,      -- 1 on the newest row per (owner, repo, ref); retention keeps it
  affected INTEGER NOT NULL,       -- count at or above min_severity
  min_severity TEXT NOT NULL,      -- low|medium|high|critical
  run_id TEXT NOT NULL,            -- token claim `run_id`
  reported_at TEXT NOT NULL        -- server ISO time of receipt
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_action_reports_run ON action_reports (owner, repo, run_id);       -- idempotency; NOT EXISTS probe
CREATE INDEX IF NOT EXISTS idx_action_reports_ref ON action_reports (owner, repo, ref);                -- ?ref= lookup ORDER BY id DESC; demote UPDATE
CREATE INDEX IF NOT EXISTS idx_action_reports_default ON action_reports (owner, repo, is_default);     -- default-branch lookup ORDER BY id DESC
CREATE INDEX IF NOT EXISTS idx_action_reports_retention ON action_reports (is_latest, reported_at);    -- retention delete + dry-run count
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('badge.retention_days','90'), ('badge.retention_batch','5000'), ('badge.retention_dry_run','0'),
  ('badge.cache_seconds','300'),
  ('action.oidc_jwks_cache_seconds','3600'), ('action.oidc_jwks_refetch_seconds','300'), ('action.oidc_clock_skew_seconds','60');
```
Each settings row gets a one-line comment, as in 0029. D1 needs no RLS, because this is SQLite and not Supabase. The migration is additive only.

SQLite adds the rowid to every index as the last column. So `WHERE owner=? AND repo=? AND ref=? ORDER BY id DESC LIMIT 1` is a SEARCH on idx_action_reports_ref with no temp B-tree. The plan test asserts this.

### Statements

- Write (one `DB.batch`, so one transaction):
  1. `UPDATE action_reports SET is_latest = 0 WHERE owner=?1 AND repo=?2 AND ref=?3 AND is_latest = 1 AND NOT EXISTS (SELECT 1 FROM action_reports WHERE owner=?1 AND repo=?2 AND run_id=?4)`. The NOT EXISTS has no correlation to the outer row. SQLite runs it once, as a seek on ux_action_reports_run.
  2. `INSERT INTO action_reports (...) VALUES (..., 1, ...) ON CONFLICT (owner, repo, run_id) DO NOTHING`.
  On a duplicate run_id, both statements change 0 rows.
- Read with ref: `SELECT affected, min_severity, reported_at FROM action_reports WHERE owner=? AND repo=? AND ref=? ORDER BY id DESC LIMIT 1`.
- Read without ref: `... WHERE owner=? AND repo=? AND is_default = 1 ORDER BY id DESC LIMIT 1`.
- Retention: `DELETE FROM action_reports WHERE rowid IN (SELECT rowid FROM action_reports WHERE is_latest = 0 AND reported_at < ?1 LIMIT ?2)`. The dry run: `SELECT COUNT(*) AS n FROM action_reports WHERE is_latest = 0 AND reported_at < ?1`. There is no correlated subquery. The latest row per ref is never a candidate.

### OIDC seam (`src/lib/github-oidc.ts`)

- `GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com"` and the JWKS URL `${issuer}/.well-known/jwks` are protocol constants, not knobs.
- `verifyGithubOidc(env, token, audience, now, fetchJwks = defaultFetcher(env))` returns the claims `{repository, repository_owner, ref, run_id, repository_visibility}` or throws `OidcError(reason)`.
- Checks: 3 parts; header `alg === "RS256"` only (`none` and HS256 are refused); `kid` is present; RSASSA-PKCS1-v1_5 SHA-256 verify with crypto.subtle; `iss` equals the issuer; `aud` equals `audience` (a string, or an array that contains it); `exp > now - skew`; `nbf` (if present) `<= now + skew`. Skew comes from `action.oidc_clock_skew_seconds`.
- JWKS cache: KV `CURSORS` key `oidc:github:jwks` = `{fetched_at, keys}`, TTL `action.oidc_jwks_cache_seconds`. If the kid is unknown, refetch once, and only when the cached copy is older than `action.oidc_jwks_refetch_seconds`. A flood of junk kids therefore costs at most one GitHub fetch per refetch window.
- `defaultFetcher(env)`: if `env.GITHUB_OIDC_TRANSPORT === "fake"`, it throws `"fake OIDC transport: seed oidc:github:jwks in KV"`. So the PR suite makes 0 calls to GitHub, and a missing seed fails loudly. Otherwise it does `fetch(JWKS_URL)` and checks `res.ok` and the shape (D9). This file is the only file that names the GitHub OIDC URLs.
- Audience: the request's own host (`new URL(c.req.url).host`, `tocsin.sh` in prod). The Action asks for audience = the host of its `base-url`. A self-hosted worker works with no knob. A token minted for another host is refused.

### Route `POST /v1/action/report`

1. If `Authorization: Bearer <jwt>` is missing or malformed, answer 401 `{error:"missing token"}`.
2. Run `verifyGithubOidc`. On an OidcError, answer 401 `{error:"invalid token", reason}`. On a JWKS fetch failure, answer 503 `{error:"oidc keys unavailable"}` (D10: narrow classes).
3. Parse the JSON body `{repository, affected, min_severity, default_branch?}`. If it is invalid, answer 400. `affected` is a safe integer >= 0. `min_severity` is in the severity set. `repository` matches `owner/repo`.
4. Lowercase both `body.repository` and `claims.repository` (D17). If they are not equal, answer 403 `{error:"token is for another repository"}`.
5. If `claims.repository_visibility !== "public"`, answer 403 `{error:"badge reports are for public repositories"}`.
6. `owner, repo` come from the claim. `ref` and `run_id` come from the claims, never from the body. `is_default = (ref === "refs/heads/" + default_branch)`. `reported_at = now` (server).
7. Run the batch. Answer 200 `{recorded: true}` when the insert changed 1 row, else 200 `{recorded: false}`.
- CORS stays GET/HEAD/OPTIONS. The caller is a CI runner, not a browser.
- Statement count: 3 settings reads in parallel (`Promise.all`) + 1 batch (2 statements). A JWKS KV hit makes no network call.

### Route `GET /badge/:owner/:repo.svg`

- Hono pattern `/badge/:owner/:file{[^/]+\\.svg}`. It has 2 segments, so it does not collide with `/badge/status.svg`.
- Validate `owner` and `repo` against `^[A-Za-z0-9_.-]+$`, then lowercase them. If invalid, answer 404 JSON (the same as notFound).
- `ref`: none means the default branch. `main` becomes `refs/heads/main`. A value that starts with `refs/` is used as is.
- Edge cache: the key is the canonical URL (lowercased owner/repo, normalized ref, other query params dropped). `caches.default.match(key)` runs first, with 0 DB statements. On a miss, the knob `badge.cache_seconds` and the lookup run in parallel (2 statements). The response is `Content-Type: image/svg+xml; charset=utf-8`, `Cache-Control: public, max-age=<knob>`, put with `c.executionCtx.waitUntil(cache.put(...))`.
- Rendering (`renderRepoBadge` in site/badge.ts):
  - no row: "tocsin | unknown", grey `#9f9f9f`
  - affected 0: "tocsin | clean", green `#2e9e44` (the existing green)
  - affected N: "tocsin | N affected", red `#e05d44`
  - The title and aria-label carry the min severity and the report date, for example `tocsin · 3 affected (high or above, 2026-10-25)`.
  - The SVG is one image link target. The README snippet wraps it in `[...](https://tocsin.sh)`, so the badge links to tocsin.sh, as the ticket asks.
- DB error: render "tocsin | unavailable" grey with `Cache-Control: no-cache` and no cache put (D11: an error is not "unknown"; no new literal).

### Retention (`runActionReportRetention`)

This is a copy of the shape of `runSendCounterRetention`. Knobs `badge.retention_days` (90), `badge.retention_batch` (5000) and `badge.retention_dry_run` (0; any other value means a dry run). The job throws when days < 1 or batch < 1. The audit goes to KV `retention:action_reports:last` and one log line, after the delete commits. A row is a CI status snapshot that the next run regenerates. It is not money and not the advisory history, so it is deleted and not archived. The newest row per ref is never deleted.

### Action (`action/check.mjs`)

- `readInputs`: `report: named("report", env.TOCSIN_REPORT, true)`.
- `postReport(io, inputs, shownCount)` is called at the end of `finish()`, on the result path only. A could-not-run path sends no report, because there is no result. The steps:
  1. If `!inputs.report`, return.
  2. If `ACTIONS_ID_TOKEN_REQUEST_URL` or `ACTIONS_ID_TOKEN_REQUEST_TOKEN` is unset, return silently. This is the default today (no `id-token: write`), and fork PRs are the same.
  3. Read `GITHUB_EVENT_PATH` → `repository.private` and `repository.default_branch`. If private is true, return silently.
  4. GET the token URL with `searchParams.set("audience", new URL(baseUrl).host)` and `Authorization: Bearer <request token>` → `{value}`.
  5. POST `${baseUrl}/v1/action/report` with `Authorization: Bearer <value>` and JSON `{repository: GITHUB_REPOSITORY, affected, min_severity, default_branch}`.
  6. Any throw or non-2xx gives `annotate(io, "warning", "could not send the badge report: ...")`. The return code of `finish` is unchanged.
- The OIDC JWT is never printed. The warning carries the status and the API `error` field only.

## Edge cases

- The same run_id twice gives 1 row. A re-run attempt of the same run_id is dropped (see ASSUMPTIONS).
- Reports for refs/pull/N/merge are stored with is_default 0. They do not show on the default badge. Retention removes them after 90 days, except the latest per ref (one row per PR ref).
- The default branch changes (main to trunk). The newest is_default row wins, because the read orders by id DESC.
- Owner and repo in mixed case: the write and the read both lowercase them (D17). A test reads `Acme/Widget` after a write of `acme/widget`.
- An expired token, a wrong aud, a wrong iss, alg none, an unknown kid and a bad signature all give 401. Each one is a test case.
- `?ref=` with a ref that has no rows gives "unknown". It does not fall back to the default.

## Iron laws applied

- Additive schema (rule 1). Indexes and retention ship in the same migration, with EXPLAIN tests (rule 2, BH-6730).
- Exactly-once on run_id (iron law: idempotent writes).
- Every new limit is a settings row with a documented code fallback that names the row (rule 5, BH-7945): 7 rows. Protocol constants (issuer, JWKS URL) and badge colors are not limits.
- Feed reads are cheap (rule 8): the badge does at most 2 statements on a cache miss and 0 on a hit. No unbounded scan.
- No secrets (rule 9): no new prod secret or env var. `GITHUB_OIDC_TRANSPORT` is set only in vitest.config.ts. `.env.example` gets no new line, because no prod variable is added (see ASSUMPTIONS).
- Advisory text is not involved (rule 10). The badge shows the count the repo's own Action reported.
- Dedup before spend: no metered call. The JWKS fetch is a free public GET, cached in KV, with the refetch bounded by a knob.
- No LLM, so De-AI does not apply. No `claude-*` string. Sortable headers, list-over-cards and drill-down do not apply, because the change has no table or list screen.
- Scalable tests (BH-7563): seam `src/lib/github-oidc.ts`. Fake: `GITHUB_OIDC_TRANSPORT=fake`, which throws on a network fetch, and the test seeds a generated key in KV. Contract: `tests/contract/github-oidc.contract.tcs-101.test.ts` (real JWKS and openid-configuration, 1 worker, main + nightly through mail-contract.yml; a vendor error is `it.skip` with a reason). The Action tests use the fake `world` fetch, which throws on any unrouted URL. Each test uses a unique owner/repo (`acme-<testname>/widget`), so the tests share no rows and no edge cache keys.
- Wrong-tenant test: a token for `acme/other` with body `acme/widget` gives 403 and 0 rows. The badge of repo B shows "unknown" after a report for repo A.
- Build discipline rules that bite this ticket: D1/D63 (mutation-check the binding check, the dedup and the retention keep-latest), D2 (all route tests go through `SELF.fetch`; the Action tests go through `run(io)`), D9/D10 (JWKS fetch `res.ok`; narrow 401/503), D11 (an error is not "unknown"), D16 (run_id dedup), D17 (lowercase owner/repo), D20 (no DROP), D21 (retention batch cap), D26 (no fabricated URLs in the docs: `https://tocsin.sh/badge/<owner>/<repo>.svg` stays a placeholder template), D56 (assert the owned fields), D62 (each branch has a case), D69 (knobs).

## Performance

- Badge (a key screen for third parties): reads are (a) the Cache API match, then on a miss (b) `getSettingInt badge.cache_seconds` and (c) the lookup, with b and c in parallel. Expected statements: 0 on a hit, 2 on a miss. Indexes: idx_action_reports_ref or idx_action_reports_default. There is no skeleton, because the response is an SVG image and not an HTML route.
- POST report: 3 settings reads in parallel, then 1 batch. Index: ux_action_reports_run, idx_action_reports_ref.
- Retention: 1 delete or 1 count, idx_action_reports_retention.
- No loading.tsx, because this is not a Next.js app.

## Entry points

- Action (`Fortunian/tocsin/action@v1`, the existing entry point): touched. Input `report`, default on, so the existing workflows send reports when they grant `id-token: write`. Test: `tests/action/report.tcs-101.test.ts` drives `run(io)`.
- `/docs` (site docs from docs/API.md): touched. It gets a "README badge" section. Test: `tests/routes/docs-badge.tcs-101.test.ts`.
- README.md and action/README.md: touched (the snippet).
- Landing page `/`: no change, because the install links there are for MCP clients and the badge is for repo owners who already use the Action.
- `/status` and `/badge/status.svg`: no change, because the feed freshness badge stays as is. Only its SVG helper moves to site/badge.ts, with the output unchanged.
- CLI `tocsin connect`, the MCP server, the skill and the plugin: no change, because agents do not embed README badges.

## Tasks

### T1. Migration 0032
Write `migrations/0032_action_reports.sql` as in Design. Add the file name to the list in `tests/worker/migrations.tcs-1.test.ts`.
VALIDATE: `npm test -- tests/worker/migrations.tcs-1.test.ts tests/routes/action-report-plan.tcs-101.test.ts`
SATISFIES: Scope 1, "Table `action_reports` (owner, repo, ref, affected, min_severity, reported_at, run_id) with its indexes ... and a retention rule (... settings row `badge.retention_days`)".

### T2. OIDC seam
Write `src/lib/github-oidc.ts`, add `GITHUB_OIDC_TRANSPORT` to `src/env.ts` and to the bindings in `vitest.config.ts`, and write `tests/routes/oidc-helpers.tcs-101.ts`.
VALIDATE: `npm test -- tests/unit/github-oidc.tcs-101.test.ts`
SATISFIES: Scope 2, "verify the JWT against GitHub's JWKS".

### T3. POST /v1/action/report
Write `src/routes/action-report.ts` and mount it in `src/app.ts`.
VALIDATE: `npm test -- tests/routes/action-report.tcs-101.test.ts`
SATISFIES: Scope 2, "bind owner/repo to the token's `repository` claim, so a repo can only report for itself. No API key needed. Idempotent on run_id."

### T4. GET /badge/:owner/:repo.svg
Write `site/badge.ts` (`flatBadge`, `renderRepoBadge`), refactor `renderBadge` in `site/freshness.ts`, write `src/routes/badge-repo.ts` and mount it in `src/app.ts`.
VALIDATE: `npm test -- tests/routes/badge-repo.tcs-101.test.ts tests/routes/site-freshness.tcs-35.test.ts`
SATISFIES: Scope 3, "Deterministic SVG, cache 5 minutes at the edge, `unknown` when no report exists. Index-backed lookup proven with EXPLAIN QUERY PLAN", and What: "shows 'tocsin | clean' or 'tocsin | N affected' ... and links to tocsin.sh".

### T5. Retention
Write `src/cron/action-reports-retention.ts` and add one line to `src/cron/run.ts`.
VALIDATE: `npm test -- tests/cron/action-reports-retention.tcs-101.test.ts tests/cron/send-counters-retention.tcs-83.test.ts tests/cron/deliveries-retention.tcs-11.test.ts`
SATISFIES: Scope 1, "keep the latest row per owner+repo+ref and 90 days of history; settings row `badge.retention_days`".

### T6. Action posts the report
Add the `report` input to `action/action.yml` and the `INPUTS` map of `tests/action/action-yml.tcs-33.test.ts`. Add `postReport` to `action/check.mjs`.
VALIDATE: `npm test -- tests/action/`
SATISFIES: Scope 4, "posts the report when `id-token: write` is granted and `report: true` (new input, default true); it never fails the job on a report error (warning only)".

### T7. Docs
Write `action/README.md`, the badge sections in `README.md` and `docs/API.md` (the snippet, the `id-token: write` permission and `on: push` to the default branch), the `action_reports` and KV audit sections in `docs/RETENTION.md`, and run `npm run gen:docs`.
VALIDATE: `npm run gen:docs -- --check && npm test -- tests/routes/docs-badge.tcs-101.test.ts tests/plugin/docs.tcs-100.test.ts`
SATISFIES: Scope 5, "badge snippet in `action/README.md`, the main README and docs/API.md; the site's install page shows it".

### T8. Contract suite path
Write `tests/contract/github-oidc.contract.tcs-101.test.ts`. Add its path and `src/lib/github-oidc.ts` to `pull_request.paths` in `.github/workflows/mail-contract.yml`.
VALIDATE: `TOCSIN_CONTRACT=1 npx vitest run --project contract tests/contract/github-oidc.contract.tcs-101.test.ts` (it passes or skips with a vendor reason) and `npm test` does not run it (`npm test -- --project contract` is not in the list in package.json).
SATISFIES: Scope 2, "verify the JWT against GitHub's JWKS" (the real JWKS shape the seam parses, kept true off the PR path).

### T9. Whole suite
VALIDATE: `npm run typecheck && npm test && npm run gen:docs -- --check` (true exit codes, no pipe, D6)
SATISFIES: Verification contract in CLAUDE.md, "A ticket is done when its acceptance tests fail before the change and pass after it."

## Verify (run, not edited)

- `npm run typecheck`, `npm test`, `npm run gen:docs -- --check`, `npm run gen:schema -- --check`, `npm run gen:skills -- --check`
- Regression risk: `tests/routes/site-freshness.tcs-35.test.ts` (renderBadge refactor), `tests/routes/site*.test.ts` (route mount order), `tests/cron/*.test.ts` (the cron list), `tests/action/*.tcs-33.test.ts` and `tests/action/*.tcs-49.test.ts` (check.mjs `finish`; they set no `ACTIONS_ID_TOKEN_*`, so `postReport` returns silently and their stdout and calls are unchanged), `tests/worker/migrations.tcs-1.test.ts`, `tests/plugin/docs.tcs-100.test.ts` (README/API.md text), `tests/launch/*` (the worker boots with the new migration).

## Changed symbols

- format `action_reports` table (migration 0032): new.
- route `POST /v1/action/report`: new.
- route `GET /badge/:owner/:repo.svg`: new.
- function `verifyGithubOidc` (src/lib/github-oidc.ts): new.
- function `flatBadge`, `renderRepoBadge` (site/badge.ts): new.
- function `renderBadge` (site/freshness.ts): the body moves to `flatBadge`, the output is unchanged. callers: left alone: `src/routes/site.ts` `/badge/status.svg` keeps the same signature.
- function `runActionReportRetention` (src/cron/action-reports-retention.ts): new.
- function `runCron` (src/cron/run.ts): the daily `41 4 * * *` branch runs one more job in its `Promise.allSettled`.
- function `readInputs` (action/check.mjs): adds `report`.
- function `finish` (action/check.mjs): calls `postReport` after the comment. The exit code logic is unchanged.
- format `action/action.yml` inputs: adds `report` (default `"true"`, env `TOCSIN_REPORT`).
- format `Env` (src/env.ts): adds optional `GITHUB_OIDC_TRANSPORT`.

## ASSUMPTIONS

- Ambiguous: "unique on owner+repo+ref" next to "keep the latest row per owner+repo+ref and 90 days of history" and a retention test that "keeps the latest per ref". A unique key per ref allows only one row per ref, so there is no history and retention has nothing to keep. Assumed: the unique key is `(owner, repo, run_id)` (the idempotency key the ticket names), and `(owner, repo, ref)` is a plain index for the lookup. Other reading: one upserted row per ref and no history, with retention deleting refs not reported for 90 days.
- Ambiguous: "lookup by owner+repo ordered by reported_at". Assumed: `reported_at` is the server time of receipt, so `ORDER BY id DESC` equals `ORDER BY reported_at DESC` and the SQLite rowid in each index serves it. Other reading: a client-reported time, which would let a repo backdate rows and needs a 4-column index.
- Ambiguous: what "default branch as reported" means. Assumed: the Action sends `default_branch` from the event payload (`repository.default_branch`) and the row stores `is_default`. Other reading: a separate per-repo table of default branches.
- Ambiguous: `ref` and `run_id` come from the body or the token. Assumed: from the token claims, so a repo cannot write a row for a ref or run it did not run. The body carries only `repository`, `affected`, `min_severity` and `default_branch`.
- Not in the ticket: private repositories. A public badge URL for a private repo would show its affected count to anyone who guesses the name. Assumed: the server refuses `repository_visibility != "public"` with 403, and the Action does not send a report when the event payload says `repository.private`. Other reading: accept every visibility.
- Idempotent on run_id: a re-run attempt (same run_id, next `run_attempt`) is not stored. Other reading: key on `(run_id, run_attempt)` so that a re-run updates the badge.
- The OIDC audience is the API host (`tocsin.sh`), with no settings row. Self-hosted workers check their own host. Other reading: a settings row `action.oidc_audience`.
- "the site's install page shows it": the site has no separate install page. `/docs` renders docs/API.md and carries the install links, so the badge section goes there. Other reading: a new section on the landing page.
- "cache 5 minutes at the edge": the Workers Cache API (`caches.default`) with `badge.cache_seconds` = 300, plus `Cache-Control: public, max-age=300` for GitHub's camo proxy.
- A failed DB read draws "unavailable" with `no-cache`, not "unknown". Other reading: "unknown" for both.
- Retention deletes old non-latest rows and does not archive them. A row is a CI snapshot that the next run regenerates, not money and not advisory history.
- The Action is silent (no line, no warning) when `id-token: write` is not granted or the repo is private. This keeps the output of existing workflows unchanged. Other reading: a notice line on each run.
- The POST route gets no per-IP rate limit. The RS256 verify is cheap and the JWKS refetch is bounded by `action.oidc_jwks_refetch_seconds`. Other reading: mount `authIpRateLimit` on it.
- No new prod env var or secret, so `.env.example` and wrangler secrets do not change.
- The ticket names the test files `tests/routes/action-report.test.ts`, `tests/routes/badge-repo.test.ts`, `tests/action/report.test.ts` and `tests/cron/action-reports-retention.test.ts`. The harness requires per-ticket names, so they get the `.tcs-101` infix.

## System invariants

(a) Cross-run state: table `action_reports` with the natural unique key `(owner, repo, run_id)`. The JWKS cache in KV is a cache only. A lost key means one refetch, never a wrong accept, because each token still needs a valid signature against GitHub's keys. The retention audit in KV `retention:action_reports:last` is overwritten each run, as for the other retention jobs.
(b) Side effects:
- The Action's POST: success = the 200 answer, and nothing on the runner records it. Failure = a warning, with the exit code unchanged. Not configured (no id-token or report false) = no request.
- The server write: the demote and the insert are one batch transaction, so a ref never has 0 or 2 latest rows after a commit.
- JWKS fetch: on success it is written to KV and then used. On failure the answer is 503, nothing is cached and no row is written.
- Edge cache put: only after a 200 SVG built from a successful read, never on the error path.
(c) Negative list for the auth gate (each must NOT write a row): a token signed by another key with a matching kid; `alg: none`; `alg: HS256` signed with the public key as the secret; the correct signature but `aud` = `evil.example`; `iss` = `https://token.actions.githubusercontent.com.evil.example`; an expired `exp`; body `acme/widget` with claim `acme/widget-fork`; body `acme/widget` with claim `acme-evil/widget`; a private repository claim; a valid token with a body `affected: -1` or `"3"`. Positive near-misses that must write: the claim `Acme/Widget` with body `acme/widget` (case); `aud` as an array that contains the host.
(d) Neighbors:
- The daily cron `41 4 * * *` already runs two jobs in `Promise.allSettled`. A third job keeps the pattern: each runs, and the first fault fails the cron. It touches only its own table.
- KV CURSORS gets 2 new keys with distinct prefixes (`oidc:github:`, `retention:action_reports:`) and no collision with ingest cursors.
- The Cache API keys are under `/badge/<owner>/<repo>.svg` and do not overlap with `/badge/status.svg`, which is not edge-cached today.
- The CORS middleware and `soRedirect` run first. tocsin.so answers 301 to a POST, and the Action uses `https://tocsin.sh`.
- There is no lock or queue interaction.

## Requirements coverage

| Requirement | Task | Test |
|---|---|---|
| Table action_reports with listed columns | T1 | action-report-plan.tcs-101 (columns exist), migrations.tcs-1 |
| Index for unique/idempotency + lookup by owner+repo | T1 | action-report-plan.tcs-101 EXPLAIN on 5,000 seeded rows |
| Retention: keep latest per ref + 90 days, `badge.retention_days` | T1, T5 | action-reports-retention.tcs-101 |
| POST /v1/action/report, OIDC JWT against GitHub JWKS | T2, T3 | action-report.tcs-101, github-oidc.tcs-101 |
| Bind owner/repo to `repository` claim; a repo reports only for itself | T3 | action-report.tcs-101 (403, 0 rows) |
| No API key needed | T3 | action-report.tcs-101 (no X-API-Key header, 200) |
| Idempotent on run_id | T3 | action-report.tcs-101 (twice gives 1 row, `recorded:false`) |
| GET /badge/<owner>/<repo>.svg, `?ref=`, default branch | T4 | badge-repo.tcs-101 |
| "clean" / "N affected" / "unknown" | T4 | badge-repo.tcs-101 |
| Links to tocsin.sh | T7 | docs-badge.tcs-101 (snippet links https://tocsin.sh) |
| Deterministic SVG | T4 | badge-repo.tcs-101 (two fetches, identical bytes) |
| Edge cache 5 minutes | T1, T4 | badge-repo.tcs-101 (max-age=300 from the knob; a second fetch after a DB delete still serves the cached SVG) |
| EXPLAIN on the lookup uses the index | T1, T4 | action-report-plan.tcs-101 |
| Action posts when id-token granted and report true | T6 | report.tcs-101 |
| `report` input default true | T6 | action-yml.tcs-33 (changed), report.tcs-101 |
| Report error is a warning, never a job failure (negative) | T6 | report.tcs-101 (500 gives a warning line, exit code 0) |
| Docs: action/README, README, API.md, site page | T7 | docs-badge.tcs-101, gen:docs --check |
| Existing /badge/status.svg unchanged (negative) | T4 | site-freshness.tcs-35 unchanged and green |

## Acceptance tests

Framework: Vitest with `@cloudflare/vitest-pool-workers` (`SELF.fetch`, `env.DB`), and plain Node for `tests/action`.

- `tests/routes/action-report.tcs-101.test.ts` (through `SELF.fetch`; the key pair comes from oidc-helpers and the JWKS is seeded in KV):
  - A valid token for `acme-a/widget` (public, ref refs/heads/main, run_id 1001) and the matching body give 200 `{recorded:true}` and exactly 1 row with owner, repo, ref, affected, min_severity, run_id and is_default=1.
  - A token for `acme-b/other` with body `acme-b/widget` gives 403 and 0 rows for both repos (wrong tenant).
  - The same run_id twice gives 1 row, and the second answer is `{recorded:false}`.
  - No Authorization header gives 401. `Bearer garbage` gives 401.
  - Every item of the negative list in System invariants (c) gives 401 or 403 (or 400 for the body cases) and 0 rows.
  - The claim `Acme-C/Widget` with body `acme-c/widget` gives 200 and the row is stored lowercase.
  - A second run on the same ref gives the newer row is_latest=1 and the older row is_latest=0.
  - The JWKS not seeded in KV gives 503 (the fake transport refuses the network).
- `tests/routes/badge-repo.tcs-101.test.ts`:
  - No report: the SVG contains `unknown` and fill `#9f9f9f`, with `Content-Type image/svg+xml`.
  - Seeded affected 0 on the default branch: `clean` and `#2e9e44`.
  - Affected 3: `3 affected` and `#e05d44`.
  - `?ref=feature-x` returns that ref's row. `?ref=refs/heads/feature-x` is the same. `?ref=none-such` gives `unknown`.
  - `Cache-Control` is `public, max-age=300`. After the settings row is set to 120 for a new repo, it is `max-age=120`.
  - The second fetch after the row is deleted still shows the first value (edge cache hit).
  - An invalid owner (`a b`) gives 404.
  - Two fetches give identical bytes.
- `tests/routes/action-report-plan.tcs-101.test.ts`: 5,000 rows are seeded over 200 repos with multi-row INSERTs. `EXPLAIN QUERY PLAN` of the ref read, the default read, the demote UPDATE, the retention DELETE and the dry-run count each shows `USING INDEX <named index>` (or `USING COVERING INDEX`), no `SCAN action_reports` and no `USE TEMP B-TREE`.
- `tests/unit/github-oidc.tcs-101.test.ts`: verifyGithubOidc with an injected counting fetcher. With an unknown kid, a stale cache refetches once and a fresh cache does not refetch. A non-ok fetch throws the fetch error class, not OidcError. With exp in the past and inside the skew, the token is accepted. Past the skew, it is refused.
- `tests/cron/action-reports-retention.tcs-101.test.ts`: the seeded rows are A (latest, 200 days old), B (not latest, 100 days old) and C (not latest, 10 days old). The run deletes B only. With dry_run=1 it reports deleted=1 and deletes nothing. With batch=1 and 2 old rows, it deletes 1 with has_more=true. `runCron` with `41 4 * * *` runs the job.
- `tests/action/report.tcs-101.test.ts` (Node, the `world` helper with a wrapped fetch):
  - With `ACTIONS_ID_TOKEN_REQUEST_URL=https://token.github.test/x?api-version=2.0` and its token set, the Action requests the token with `audience=api.tocsin.test` and POSTs `/v1/action/report` with `Authorization: Bearer <fake jwt>` and body `{repository:"acme/widget", affected:N, min_severity:"low", default_branch}`.
  - A 500 from the API gives a `::warning title=tocsin::could not send the badge report` line and exit code 0. With fail-on affected and 1 affected, the exit code stays 1.
  - `report: false` gives no token request.
  - No `ACTIONS_ID_TOKEN_*` gives no token request and no new stdout line.
  - `repository.private: true` gives no request.
  - The JWT value never appears in stdout.
- `tests/routes/docs-badge.tcs-101.test.ts`: `GET /docs` contains `/badge/&lt;owner&gt;/&lt;repo&gt;.svg` (escaped as rendered) and `id-token: write`. README.md and action/README.md contain the snippet `[![tocsin](https://tocsin.sh/badge/<owner>/<repo>.svg)](https://tocsin.sh)`.
- `tests/contract/github-oidc.contract.tcs-101.test.ts` (off the PR path, skips unless TOCSIN_CONTRACT=1): the real `/.well-known/openid-configuration` issuer equals `GITHUB_OIDC_ISSUER`, and the real JWKS has 1 or more RSA keys with `kid` that crypto.subtle imports. A network error is a skip with a reason.

## QA screens

- `https://tocsin.sh/badge/<owner>/<repo>.svg` for a repo with no report: a grey "unknown" badge renders in a browser and in a GitHub README.
- `https://tocsin.sh/docs`: the "README badge" section shows the snippet and the `id-token: write` permission. Check at 375px with no horizontal body scroll (code blocks scroll inside their own container, as today).
- `https://tocsin.sh/badge/status.svg`: unchanged.
- [NOTE] not verified here: a real GitHub workflow run that mints an OIDC token and posts to prod. This needs a deployed worker and a public test repo.

## Design collision check (BH-5791)

Checked 12 listed and 0 derived symbols against main d537d5d4de70..d537d5d4de70 and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size

FILES: 14
LINES: 560
DIFF_KB: 75

KIND: feature
SIZE: L
