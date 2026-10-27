# TCS-106 plan: auto-post critical runtime advisories to @tocsinagent on X

Ticket: Fortunian/tocsin#106, filed 2026-10-27T16:12:48Z, label ai-build, 2 comments (both liorwn, 16:21Z and 16:25Z).
Base: main @ 8d01a59. `git log origin/main --since=2026-10-27T16:12:48Z` is empty and `git log origin/main -S social_posts` is empty: nothing on main yet.
No PR for TCS-106 (open or closed). No sibling claims under /root/harness/state/claims/tocsin/ (directory empty).
Prior attempt: build tocsin-TCS-106-202610271621 executed an earlier version of this plan and pushed `origin/ticket/tcs-106` (4d0c70c, 39 files, no PR). The pipeline refused that plan as PLAN_STALE because it did not cite the 2 comments. This build runs on `ticket/tcs-106-r2` from main. The executor MAY reuse code from `origin/ticket/tcs-106` where it matches this plan, but every reused file must pass this plan's tests, and the billing-error changes below are new.
CodeGraph: NOT AVAILABLE on this box. File set below comes from grep + reads (callers named per file).

## Spec changes from comments
Newest first.
- 6447444139 liorwn (2026-10-27T16:25:58Z): credits are bought, so the contract test can post for real; the secrets are on the worker; the handle is @tocsinagent. Change: the contract suite's post+delete case runs a real post when the X secrets are present in CI (no "skip because no credits" path is needed for the normal run). Delivered by T10. The billing rule of the older comment stays (this comment does not reverse it; it only says the balance is no longer 0).
- 6447345509 liorwn (2026-10-27T16:21:45Z): (1) the handle is @tocsinagent, not @tocsin_sh; use @tocsinagent everywhere. Delivered by T11 (docs, code comments, contract text) and a grep check that `tocsin_sh` appears nowhere in the diff. (2) The 4 worker secrets are set (`X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, OAuth 1.0a user context). Delivered by T3 (names unchanged). (3) A real post can fail with a billing error (no credits); the contract test must report that as a vendor failure, not a code failure. Delivered by T3 (the seam classifies a billing answer as `kind: "billing"`) and T10 (the contract suite skips with a reason plus an alert line on `billing`, 429, 5xx and network). Also T6: in the lane a billing answer is retryable within the attempt cap, like 429 (no post was made and nothing was charged).

## Scope

One new lane, `social`, that runs in the `*/10` cron tick after webhook work. It finds runtime advisories at or above `social.x.min_severity` that are new since the last tick, writes one `social_posts` row per (advisory, channel) BEFORE any X call, and posts at most `social.x.daily_cap` per UTC day through one seam (`src/social/x.ts`). Plus: a daily retention job that archives old terminal rows, a `social` block in `GET /v1/status`, a bearer-gated replay route, docs, and a contract suite off the PR path.

Out of scope: any change to ingesters, the feed, the site `/status` page, watch lists, mail.

## Design (decided here)

### Store
- New table `social_posts` (migration `0033_social_posts.sql`):
  `id INTEGER PRIMARY KEY, advisory_id TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL` (`pending | sending | ok | empty | failed`), `attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL` (due time while pending; lease end while sending), `first_attempt_at TEXT, posted_id TEXT, posted_at TEXT, error TEXT` (max 200 chars), `text TEXT NOT NULL` (the exact text sent, for the audit and replay), `created_at TEXT NOT NULL, updated_at TEXT NOT NULL`.
  `pending` and `sending` are additions to the ticket's ok/empty/failed: `pending` is the row written before the call (dedup-before-spend), `sending` is the claimed-in-flight state.
- New table `social_posts_archive`: same columns plus `archived_at TEXT NOT NULL`. History is archived, never silently deleted (ticket scope 1).
- Watermark: one new row `('social:x', MAX(cursor), now)` in the existing `match_cursors` table (seeded in 0033 with `INSERT OR IGNORE ... SELECT COALESCE(MAX(cursor),0)`). Natural key `lane`. No new watermark table, no KV.
- Lane status: one new `sources` row `('social-x', 'social', enabled 0)`, the same warning-channel pattern as the `mail` row (migration 0030). `enabled = 0` keeps it out of `runIngesters` (`ENABLED_SOURCES_SQL` reads `enabled = 1`) and out of the status `sources[]` list. The lane overwrites `last_run_at` and `last_error` on each enabled run.

### Indexes (same migration, each with the query it serves)
- `ux_social_posts_advisory_channel UNIQUE (advisory_id, channel)`: the dedup lookup and `INSERT ... ON CONFLICT(advisory_id, channel) DO NOTHING`.
- `idx_social_posts_due (channel, status, next_at)`: the claim `WHERE channel=?1 AND status='pending' AND next_at<=?2 ORDER BY next_at LIMIT ?3` and the stale-lease sweep `WHERE channel=?1 AND status='sending' AND next_at<=?2`.
- `idx_social_posts_attempted (channel, first_attempt_at)`: the daily cap count `WHERE channel=?1 AND first_attempt_at>=?2`.
- `idx_social_posts_posted (channel, status, posted_at)`: `posted_24h` `WHERE channel='x' AND status='ok' AND posted_at>=?1`.
- `idx_social_posts_retention (created_at)`: the archive select `WHERE created_at<?1 AND status IN ('ok','empty','failed') LIMIT ?2`.
- `ux_social_posts_archive_advisory_channel UNIQUE (advisory_id, channel)` on the archive: `INSERT OR IGNORE` idempotency and the replay lookup.
- Candidate scan reads existing `idx_advisories_ecosystem_cursor (ecosystem, cursor)`: one statement per ecosystem in one `db.batch`, `WHERE ecosystem=?1 AND cursor>?2 ORDER BY cursor LIMIT ?3`. No IN-list over ecosystems (it would not seek), no correlated subquery.
- No RLS: D1/SQLite, not Supabase.

### Settings rows (seeded in 0033 with `INSERT OR IGNORE`; code fallback constants name the row)
| key | default | meaning |
|---|---|---|
| `social.x.enabled` | `0` | 1 posts; any other value posts nothing |
| `social.x.min_severity` | `critical` | lowest label that qualifies |
| `social.x.sources` | `node-runtime,php-runtime,python-runtime,deno-runtime,bun-runtime,osv-go-toolchain` | `osv-go-toolchain` = OSV `Go` rows that `isGoToolchainAdvisory` (src/check/go-runtime.ts) accepts |
| `social.x.daily_cap` | `10` | X calls per UTC day (first attempts) |
| `social.x.max_age_hours` | `72` | an advisory whose `published_at` is older never qualifies (backfill and first-enable guard) |
| `social.x.scan_rows` | `200` | per-ecosystem candidate rows read per tick |
| `social.x.max_attempts` | `3` | 429/5xx attempt cap |
| `social.x.retry_seconds` | `600` | wait before the next attempt after a 429/5xx |
| `social.x.lease_seconds` | `300` | a `sending` row older than this is terminal `failed`/`unknown_outcome` |
| `social.x.timeout_ms` | `10000` | fetch timeout of one X call |
| `social.x.max_chars` | `280` | X weighted length limit |
| `social.x.url_chars` | `23` | X t.co weight of one URL |
| `social.retention_days` | `365` | terminal rows older than this are archived |
| `social.retention_batch` | `5000` | most rows archived per run |
| `social.retention_dry_run` | `0` | any other value counts and moves nothing |

Read through one statement: `SELECT key, value FROM settings WHERE key IN (...)` (PK seeks) in a small `readSocialConfig(db)` helper, with `src/lib/settings.ts` / `src/lib/settings-text.ts` parsing rules (a malformed row falls back and logs).

### Selection rule (pure function `qualifies(doc, row, cfg, prevScanAt, now)` in `src/social/select.ts`)
An advisory qualifies once, when ALL hold:
1. One of its `doc.sources[].source` is in `social.x.sources`, or the token `osv-go-toolchain` is listed, the row is ecosystem `Go`, a source is `osv`, and `isGoToolchainAdvisory(doc)` is true.
2. `severity.label` rank >= `min_severity` rank (critical 4, high 3, medium 2, low 1, unknown 0). An unknown `min_severity` value falls back to `critical`.
3. First sight: the ULID time of `advisory.id` (decode the 10 time chars of `tcs_<ULID>`; `newAdvisoryId(now)` in src/ingest/ulid.ts mints it at insert) is AFTER the watermark's `updated_at` (the previous scan). An update to an older advisory bumps its cursor but keeps its id, so it never qualifies. A medium row later raised to critical never qualifies.
4. `published_at` is within `social.x.max_age_hours` of now.
5. Not withdrawn: the doc has no non-empty `withdrawn` value (see ASSUMPTIONS 1).
6. No `social_posts` row for (advisory_id, 'x') exists (the insert's `ON CONFLICT DO NOTHING` enforces it; selection does not need a separate read).

### Lane run (`runSocialLane(env, now)` in `src/cron/social.ts`, called from `runCron` after `sweepDeliveries`, in its own try/catch like the other lanes)
1. Read config (1 statement).
2. If `enabled != 1`: advance the watermark to `MAX(cursor)` and `updated_at = now` (1 statement) and stop. Turning the flag on never posts a backlog.
3. If any of the 4 X secrets is missing (`getXClient` answers null): advance the watermark, write `sources['social-x'].last_error = 'not_configured'`, stop. No row is written, no call is made.
4. One `db.batch`: watermark row + one candidate scan per configured ecosystem (`node`, `php`, `python`, `deno`, `bun`, `Go`; only those the configured sources need) + stale-lease sweep (`UPDATE ... SET status='failed', error='unknown_outcome' WHERE channel='x' AND status='sending' AND next_at<=now`).
5. Apply `qualifies` in code. Build the text (below). One `db.batch`: multi-row `INSERT ... ON CONFLICT(advisory_id, channel) DO NOTHING` of `pending` rows (`next_at = now`, `text` stored) + watermark update. New watermark = the lowest last-read cursor among ecosystems whose scan hit `scan_rows`, else the batch's `MAX(cursor)` read at step 4; `updated_at = now`. The watermark advances only after the inserts commit (same batch).
6. Room = `daily_cap` − count of rows with `first_attempt_at >= today 00:00Z`. If room <= 0: stop (pending rows wait for the next UTC day; defer, never drop).
7. Claim: `UPDATE social_posts SET status='sending', attempts=attempts+1, first_attempt_at=COALESCE(first_attempt_at, ?now), next_at=?lease_end, updated_at=?now WHERE id IN (SELECT id FROM social_posts WHERE channel='x' AND status='pending' AND next_at<=?now ORDER BY next_at LIMIT ?room) RETURNING id, advisory_id, text, attempts`. The claim is one atomic statement, so two overlapping ticks never send one row twice.
8. Per claimed row, sequentially (each one costs money; no parallel spend): `client.post(text)` then one UPDATE by outcome:
   - 2xx with `data.id` → `ok`, `posted_id`, `posted_at`.
   - 2xx without `data.id` → `empty`, terminal.
   - 429, 5xx or billing (402, or a 403 whose body names credits/billing/payment/enrollment; comment 6447345509) → `pending` with `next_at = now + retry_seconds` when `attempts < max_attempts`; else `failed`, terminal. A billing error writes `error` prefixed `billing:` and `sources['social-x'].last_error` shows it, so the operator sees it in `/v1/status`.
   - other 4xx (401, 403 incl. duplicate content) → `failed`, terminal.
   - network error / timeout → `failed`, terminal, error `network` (ASSUMPTIONS 4).
   - `error` = `"x answered <status>: <body first 200 chars>"`, never a header, never a token.
9. Write `sources['social-x']` `last_run_at = now`, `last_error` = the last error of this run or null.

Expected statements per enabled tick: 1 config + 1 batch (≤ 8) + 1 batch (insert + watermark) + 1 count + 1 claim + 1 per post + 1 sources write. Disabled tick: 2 (config + watermark).

### Text (`renderPostText(doc, cfg, origin)` in `src/social/text.ts`, pure, no LLM)
`<Runtime> <lines>: <summary>. Severity <label>, fixed in <fixed list>. https://tocsin.sh/advisories/<id>`
- Runtime display: node → `Node.js`, php → `PHP`, python → `Python`, deno → `Deno`, bun → `Bun`, Go toolchain → `Go`.
- `<lines>`: the release lines of `fixed_versions` (major for node/deno/bun, major.minor for php/python/go), sorted by semver, joined `, `, e.g. `Node.js 20.x, 22.x, 24.x`. No fixed versions: lines from `affected[].introduced`; none at all: the runtime name only.
- `<fixed list>`: `fixed_versions` sorted by semver, joined `, ` (each is the first fixed version of its line, ASSUMPTIONS 2). Empty: the clause becomes `no fixed version yet`.
- Origin: the existing `https://tocsin.sh` base (reuse the constant the discovery route uses, src/routes/discovery.ts:7, by exporting it or a shared one; no new literal).
- Budget: weighted length (code points U+0000–U+10FF, U+2000–U+200D, U+2010–U+201F, U+2032–U+2037 weigh 1, all others 2; the URL weighs `url_chars`) must be <= `max_chars`. Over budget: cut the summary with `…` first; if still over, cut the fixed list to the first N plus `+<k> more`. Never cut the URL.

### Seam (BH-7563)
- `src/social/x.ts`: the one X adapter. `interface XClient { post(text): Promise<XPostResult>; remove(id): Promise<XDeleteResult> }`. `XPostResult` carries `kind: "ok" | "empty" | "retryable" | "billing" | "terminal" | "network"`, `status`, `id?`, `error?` (200 chars max). The classifier `classifyXAnswer(status, body)` is a pure exported function, so the lane, the replay route and the contract suite share one rule. `getXClient(env)` answers `FakeX` when `env.SOCIAL_TRANSPORT === "fake"` (set only in vitest.config.ts), `RealX` when all 4 secrets are set, else null. Only this file builds an `api.x.com` URL and calls `fetch` for X. Uses `AbortSignal.timeout(timeout_ms)`.
- `src/social/oauth1.ts`: OAuth 1.0a HMAC-SHA1 signing (RFC 5849 §3.4) with `crypto.subtle`, no npm dependency. The JSON body of `POST /2/tweets` is not part of the base string (not form-encoded).
- `src/social/fake.ts`: 0 network calls. Records each call in a KV outbox (`social:fake:calls`, TTL 3600) like `src/mail/fake.ts`. Its answer is driven by a KV key `social:fake:mode` (`ok` default, `429`, `500`, `402`, `403`, `empty`, `network`), so tests drive every branch. `remove` throws `unimplemented` (the PR suite never deletes).
- Contract suite `tests/contract/social-x.contract.tcs-106.test.ts`: `describe.skipIf(!CONTRACT_ENABLED || !secrets)`, 1 worker. Posts one `[contract test] ...` message to @tocsinagent, asserts an id, deletes it with `DELETE /2/tweets/:id`, asserts `deleted: true`. A second case signs with a wrong consumer secret and asserts the client classifies the 401 as terminal (no post spend). A vendor answer of kind `billing`, `retryable` (429/5xx) or `network` skips with a reason and prints one `{"lane":"social-contract","alert":"vendor_failure",...}` line, the same shape as `vendorFailure` in tests/contract/mail-resend.contract.tcs-97.test.ts (rule 7; comment 6447345509). With credits bought (comment 6447444139) the normal run posts for real. The contract text starts `[contract test]` and names no advisory. Workflow `.github/workflows/social-contract.yml`: push to main, nightly, PRs touching `src/social/x.ts`, `src/social/oauth1.ts` or the contract file; env reads the 4 X secrets from GitHub Actions secrets. One real post per run (about $0.20).

### Replay route `POST /v1/internal/social/replay` (`src/routes/social-replay.ts`)
- Auth: the existing IMPORT_TOKEN bearer guard. Export the `auth` function from src/routes/internal-import.ts (one keyword) and reuse it; no copy.
- Body `{"advisory_id": "tcs_..."}`, ID pattern checked, body limit from existing `import.max_body_bytes`.
- Row `ok` in `social_posts` or the archive → `200 {"status":"ok","changed":false}`, writes nothing.
- Advisory missing → 404. Withdrawn → 409. `social.x.enabled != 1` → 409. Client null → 503. No room under the daily cap → 429. None of these write.
- Else: upsert the row to `pending` (`attempts = 0`, new text) and run steps 7–8 for that one row; answer the row's status.
- Not reachable from a browser: CORS for `/v1/internal/*` stays as app.ts sets it for import.

### Retention (`src/cron/social-retention.ts`, daily `41 4 * * *` with the other daily jobs in `runCron`'s `Promise.allSettled` list)
One `db.batch` (one transaction), two statements:
1. `INSERT OR IGNORE INTO social_posts_archive (<all columns>, archived_at) SELECT <all columns>, ?now FROM social_posts WHERE id IN (SELECT id FROM social_posts WHERE created_at < ?cutoff AND status IN ('ok','empty','failed') ORDER BY created_at LIMIT ?batch)`.
2. `DELETE FROM social_posts WHERE id IN (SELECT id FROM social_posts WHERE created_at < ?cutoff AND status IN ('ok','empty','failed') ORDER BY created_at LIMIT ?batch) AND EXISTS (SELECT 1 FROM social_posts_archive a WHERE a.advisory_id = social_posts.advisory_id AND a.channel = social_posts.channel)`.
The EXISTS probe is one seek on the archive's unique index per deleted row (at most `batch` rows), so a row is deleted only when its archive copy exists. Dry run counts only. Audit record to KV `retention:social_posts:last` like `retention:action_reports:last`. The archive is kept forever (history, small: at most `daily_cap` rows per day).

### Status block
`GET /v1/status` gains `social: { enabled: boolean, posted_24h: number, last_error: string | null }` from `loadSocialStatus(db, now)` in `src/social/status.ts`: one `db.batch` of 3 PK/index reads (setting row, count via `idx_social_posts_posted`, `sources` row `social-x`). It runs in parallel with `loadStatus` (`Promise.all`) in src/routes/status.ts. `loadStatus` itself is not changed, so the `/status` site page is not touched.

## Files to touch
1. `migrations/0033_social_posts.sql` (new)
2. `src/social/x.ts` (new)
3. `src/social/oauth1.ts` (new)
4. `src/social/fake.ts` (new)
5. `src/social/config.ts` (new)
6. `src/social/select.ts` (new)
7. `src/social/text.ts` (new)
8. `src/social/status.ts` (new)
9. `src/cron/social.ts` (new)
10. `src/cron/social-retention.ts` (new)
11. `src/routes/social-replay.ts` (new)
12. `src/cron/run.ts` (2 lines: lane call after sweep; retention in the daily list)
13. `src/routes/status.ts` (social block)
14. `src/routes/internal-import.ts` (export `auth`)
15. `src/routes/discovery.ts` (export `BASE`, if no shared origin constant exists)
16. `src/app.ts` (mount `/v1/internal/social/replay`)
17. `src/env.ts` (4 X secrets + `SOCIAL_TRANSPORT`)
18. `vitest.config.ts` (`SOCIAL_TRANSPORT: "fake"` binding)
19. `.env.example` (4 X variables)
20. `.github/workflows/social-contract.yml` (new)
21. `docs/OPERATING.md`, `docs/API.md`, `docs/RETENTION.md`
21b. `tests/worker/migrations.tcs-1.test.ts`, `tests/routes/site-plan.tcs-10.test.ts` (premise changes, see Tests that must change)
22. `site/docs.generated.ts` (regenerated by `npm run gen:docs` after the API.md edit)
23. Tests (new, per-ticket): `tests/social/select.tcs-106.test.ts`, `tests/social/classify.tcs-106.test.ts`, `tests/social/dedup.tcs-106.test.ts`, `tests/social/text.tcs-106.test.ts`, `tests/social/oauth1.tcs-106.test.ts`, `tests/social/budget.tcs-106.test.ts`, `tests/social/lane.tcs-106.test.ts`, `tests/social/replay.tcs-106.test.ts`, `tests/social/retention.tcs-106.test.ts`, `tests/social/status.tcs-106.test.ts`, `tests/social/helpers.tcs-106.ts`, `tests/contract/social-x.contract.tcs-106.test.ts`

Regression risk (grep evidence, no graph): `src/cron/run.ts` is called by `src/index.ts` scheduled handler and pinned by `tests/cron/run.tcs-2.test.ts`; `src/routes/status.ts` is read by `tests/routes/site.tcs-10.test.ts:241`, `tests/routes/status-*.ts`, `tests/ingest/node-runtime-ledger.tcs-69.test.ts:556`, and `scripts/launch-check.sh` via `tests/launch/*`; `src/routes/internal-import.ts` by `tests/routes/internal-import.tcs-32.test.ts`; `vitest.config.ts` is read raw by `tests/routes/keys-budget.tcs-64.test.ts` (project names only); the `sources` row count is in docs/RETENTION.md.

## Tests that must change
- `tests/worker/migrations.tcs-1.test.ts`: pins the applied migration list as 0001..0032; this ticket adds `0033_social_posts.sql` (append one name, rename the case to 0001..0033).
- `tests/routes/site-plan.tcs-10.test.ts`: pins the `sources` table at 11 rows; this ticket adds the disabled `social-x` row (12).

## Verify (run, not edited)
- `npm test`, `npm run typecheck`, `npm run migrate:local`, `npm run gen:docs -- --check`
- `tests/cron/run.tcs-2.test.ts`, `tests/routes/site.tcs-10.test.ts`, `tests/routes/status-ledger.tcs-50.test.ts`, `tests/routes/status-coverage.tcs-32.test.ts`, `tests/routes/internal-import.tcs-32.test.ts`, `tests/routes/keys-budget.tcs-64.test.ts`, `tests/launch/*`

## Tasks

### T1 Migration 0033
Tables, indexes, settings rows, `match_cursors` row `social:x`, `sources` row `social-x` (enabled 0). Additive only: CREATE TABLE/INDEX IF NOT EXISTS and INSERT OR IGNORE; no ALTER, no DROP.
VALIDATE: `npm run migrate:local` exits 0, and `npm test -- tests/social/dedup.tcs-106.test.ts` EXPLAIN cases pass.
SATISFIES: Scope 1 "Table social_posts ... unique index on (advisory_id, channel) and a retention rule"; Scope 2 settings rows.

### T2 OAuth 1.0a signer
VALIDATE: `npm test -- tests/social/oauth1.tcs-106.test.ts` (RFC 5849 §1.2 example signature `tR3+Ty81lMeYAr/Fid0kMTYa/WM=`; percent-encoding of reserved chars).
SATISFIES: Scope 4 "OAuth 1.0a user context (HMAC-SHA1 signing in the worker, no npm dependency)"; acceptance "oauth1.test.ts".

### T3 X seam + fake
`src/social/x.ts`, `src/social/fake.ts`, env.ts, vitest.config.ts binding, .env.example.
VALIDATE: `npm test -- tests/social/budget.tcs-106.test.ts tests/social/classify.tcs-106.test.ts` (getXClient answers the fake under the binding; a full enabled lane run with a `fetch` spy records 0 calls to `api.x.com`; `grep -rln "api.x.com" src` lists only `src/social/x.ts`; `classifyXAnswer` table passes).
SATISFIES: Scope 4 "The seam is one adapter file src/social/x.ts; a fake in test mode makes 0 network calls"; acceptance "Budget test: 0 X calls in the PR suite"; comment 6447345509 "a real post fails with a billing error ... report that as a vendor failure".

### T4 Config + selection
VALIDATE: `npm test -- tests/social/select.tcs-106.test.ts`
SATISFIES: Scope 2 selection rule; acceptance "a critical node-runtime advisory qualifies once; a medium one never; a withdrawn one never; an update to an already-posted advisory never".

### T5 Text
VALIDATE: `npm test -- tests/social/text.tcs-106.test.ts`
SATISFIES: Scope 3 template and length budget; acceptance "text.test.ts ... 2026-10-21 Node and PHP fixtures ... 23-char URL weighting".

### T6 Lane + cron wiring
`src/cron/social.ts`, one call in `src/cron/run.ts`.
VALIDATE: `npm test -- tests/social/dedup.tcs-106.test.ts tests/social/lane.tcs-106.test.ts tests/cron/run.tcs-2.test.ts`
SATISFIES: Scope 1 dedup-before-spend; Scope 4 attempt cap / empty terminal / 200-char error; Scope 5 "Runs from the existing cron tick after ingestion, bounded by the daily cap".

### T7 Status block
VALIDATE: `npm test -- tests/social/status.tcs-106.test.ts tests/routes/site.tcs-10.test.ts tests/routes/status-ledger.tcs-50.test.ts`
SATISFIES: Scope 5 "GET /v1/status gains a social block (enabled, posted_24h, last_error)".

### T8 Replay route
VALIDATE: `npm test -- tests/social/replay.tcs-106.test.ts tests/routes/internal-import.tcs-32.test.ts`
SATISFIES: Scope 6 "replay one advisory by hand (POST /v1/internal/social/replay, bearer IMPORT_TOKEN, writes nothing when the row is ok)".

### T9 Retention
VALIDATE: `npm test -- tests/social/retention.tcs-106.test.ts`
SATISFIES: Scope 1 "retention rule (settings row social.retention_days, default 365; history rows archived, never silently deleted)".

### T10 Contract suite + workflow
VALIDATE: `npm run test:contract -- tests/contract/social-x.contract.tcs-106.test.ts` without X secrets reports the suite skipped and exits 0; `npm test` does not include it (keys-budget project check stays green); `grep -n "vendor_failure" tests/contract/social-x.contract.tcs-106.test.ts` shows the billing/429/5xx/network skip path.
SATISFIES: Scope 4 "a contract suite (about 5 tests, 1 worker, main + nightly) is skipped without the secrets"; acceptance "social-x.contract.test.ts"; comment 6447345509 (billing = vendor failure) and comment 6447444139 (credits bought, contract posts for real).

### T11 Docs
OPERATING.md section (secrets with `wrangler secret put`, the enable flip SQL, the cap, replay curl, what each `last_error` means); API.md status block; RETENTION.md sections for `social_posts`, `social_posts_archive`, KV `retention:social_posts:last`, updated settings and sources counts; regenerate site/docs.generated.ts.
VALIDATE: `npm run gen:docs -- --check` exits 0; `grep -n "social" docs/OPERATING.md docs/API.md docs/RETENTION.md` shows each section; `git diff origin/main -- . | grep -c tocsin_sh` prints 0 and `grep -n "@tocsinagent" docs/OPERATING.md` matches.
SATISFIES: Scope 6 "Docs: docs/OPERATING.md section for the secrets, the enable flip, the cap, and how to replay"; Files "docs/API.md (status block)"; comment 6447345509 "use @tocsinagent everywhere".

## Entry points
no user-facing entry point (a backend cron lane, an operator route and a status field; tocsin has no in-app UI for this).

## Changed symbols
- function `runCron`: calls `runSocialLane` after `sweepDeliveries`; adds `runSocialRetention` to the daily list.
- route `GET /v1/status`: adds the `social` block.
- route `POST /v1/internal/social/replay`: new.
- function `auth` (src/routes/internal-import.ts): exported, behavior unchanged. callers: left alone: the import route keeps using it as is.
- function `runSocialLane`, `qualifies`, `renderPostText`, `getXClient`, `classifyXAnswer`, `signOAuth1`, `loadSocialStatus`, `runSocialRetention`: new.
- format `migrations/0033_social_posts.sql`: new tables `social_posts`, `social_posts_archive`; new rows in `settings`, `match_cursors`, `sources`.
- format `Env`: adds `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `SOCIAL_TRANSPORT`.

```pr-body-requires
TEST-CHANGE: <- Tests that must change (2 lines)
## New secrets <- CLAUDE.md "New env var: the PR body must list where it needs setting"
## ASSUMPTIONS <- harness: ASSUMPTIONS copied verbatim into the PR body
```

## ASSUMPTIONS
1. Withdrawn. The stored advisory doc has no `withdrawn` field (schema/advisory.v1.json, `additionalProperties: false`). The runtime ingesters already refuse withdrawn records at ingest (src/ingest/github-runtime.ts:152, src/ingest/python-runtime-normalize.ts:85, src/ingest/php-runtime.ts:162), so a withdrawn runtime advisory never reaches `advisories`. The OSV cron path (`normalizeOsv`, src/ingest/osv.ts:235) does not drop withdrawn records, so a Go toolchain record withdrawn at first sight can be stored. Assumed: do not change ingestion in this ticket; the selector refuses any doc that carries a non-empty `withdrawn`, and the replay route does the same. Other reading: make `normalizeOsv` skip records with `withdrawn` (as the backfill already does, src/routes/internal-import.ts:184). That changes the feed for every OSV ecosystem, so it is left for a separate ticket.
2. "fixed in <first fixed>": assumed to mean the first fixed version of each affected release line, which is what `fixed_versions` holds, joined with `, `. Other reading: only the lowest fixed version. That would tell a 24.x user the 20.x fix.
3. "<version(s)>": assumed to be the affected release lines (`20.x, 22.x, 24.x`), derived from `fixed_versions`. Other reading: full version ranges; they do not fit 280 chars for Node.
4. A network error or timeout on the X call is terminal `failed` (`network`), not retried. The post may have gone out, and a retry could post twice and pay twice. The ticket names only 429 and 5xx as retryable. A `sending` row whose lease expired is terminal `failed` (`unknown_outcome`) for the same reason.
5. First sight is the advisory id's ULID time against the previous scan time, plus `published_at` within `social.x.max_age_hours` (default 72). The age knob is an addition: without it an OSV Go backfill or an enable after a long pause could post old advisories as "new".
6. Disabled or not configured: the lane still moves the watermark each tick, so turning it on never posts a backlog.
7. Over the daily cap, qualifying rows wait as `pending` and post on the next UTC day (defer, never drop). The cap counts first attempts per UTC day, not a rolling 24 h.
8. `pending` and `sending` are statuses beyond the ticket's ok/empty/failed. They are needed to write the row before the call and to claim it atomically.
9. The replay route refuses when `social.x.enabled` is not 1 (409) and respects the daily cap (429). Other reading: replay ignores both; that lets a hand call spend past the cap.
10. Test files follow the harness per-ticket naming (`tests/social/select.tcs-106.test.ts` and so on), not the ticket's `tests/social/select.test.ts`. Same content.
11. The contract suite has 2 cases (post+delete, bad signature), not 5. Each real post costs about $0.20, so the nightly run keeps to 1 post.
12. `social.x.sources` uses the pseudo-source token `osv-go-toolchain` for "Go toolchain rows from OSV", because those rows come from source `osv` and a plain `osv` entry would admit every OSV ecosystem.
13. Billing error shape. Comment 6447345509 says a post fails "with a billing error" without the HTTP shape. Assumed: X answers 402, or 403 with a body that names credits, billing, payment or enrollment. Other reading: a single exact code. The classifier is one pure function with a table test, so a wrong guess is a one-line fix. In the lane a billing answer is retryable within the attempt cap (no post, no charge); other reading: terminal at once.
14. The contract workflow reads the 4 X secrets from GitHub Actions repo secrets. Comment 6447444139 says they are set on the worker (wrangler); it does not say they are set in GitHub. Without them the suite skips with a reason. The PR body lists the 4 GitHub secrets as an operator step.

## Sibling claims (not touched)
None live at plan time.

## System invariants
(a) Cross-run state: `social_posts` with natural unique key `(advisory_id, channel)` is the dedup and spend ledger; `match_cursors` row `social:x` is the watermark (natural key `lane`); `sources` row `social-x` holds the last run's error (overwritten, does not grow). Settings rows are knobs only. The archive keeps the same unique key.
(b) Side-effect semantics for the X call: the row is written `pending` and then claimed `sending` with `attempts+1` BEFORE the call. Success with id → `ok` + `posted_id`; success without id → `empty` terminal; 429/5xx → `pending` retry or `failed` at the cap; other 4xx, network, lease expiry → `failed` terminal. Not configured → no row, no call, `last_error='not_configured'`. Disabled → no row, no call. A row can never be `ok` without a 2xx and an id from X. A crash after the call leaves `sending`, which ends `failed/unknown_outcome`, never a second call.
(c) Negative list (must NOT post; each is a test case): a fourth attempt after 3 billing answers; a plain 403 duplicate-content answer is not treated as billing (no retry); medium/high advisory at default min severity; an npm, PyPI or Packagist advisory at critical; an OSV Go module (non-toolchain) row at critical; an update to an existing advisory (cursor bump, same id); a medium advisory later raised to critical; an advisory published more than 72 h ago; a doc with `withdrawn`; any advisory while `social.x.enabled = 0`; anything when a secret is missing; a 4th attempt after 3 failures; a second tick for an `ok` or `empty` row; a replay of an `ok` row.
(d) Neighbors: `runCron` `*/10` lane order (ingest → enqueue → depmatch → sweep → social → reencrypt); the social lane's throw is caught and logged, so it never fails the cron or the lanes after it. Daily `41 4 * * *` list: retention joins `Promise.allSettled`, so one failing job does not stop the others. `match_cursors`: `dependency-match.ts` reads only lane `dependencies` (src/watchlists/dependencies.ts:44 filters by lane), so the new row does not interact. `sources`: `runIngesters` reads `enabled = 1` only and the status list reads enabled sources, so `social-x` (enabled 0) is invisible to both, like `mail`. Overlapping cron invocations: the claim UPDATE is atomic, so no row is sent twice. D1 per-invocation query limit: a tick uses fewer than 20 statements plus 1 per post, at most `daily_cap`.

## Requirements coverage
| Requirement | Task | Test |
|---|---|---|
| social_posts table with listed columns | T1 | dedup (rows asserted) |
| unique index (advisory_id, channel) | T1 | dedup EXPLAIN case |
| retention rule, social.retention_days 365, archive not delete | T1, T9 | retention.tcs-106 |
| row written BEFORE the X call | T6 | dedup "row exists at call time" |
| second tick never calls X | T6 | dedup "two ticks → 1 call" |
| social.x.enabled default 0 | T1, T6 | lane "enabled=0 → 0 calls"; status default false |
| social.x.min_severity default critical | T1, T4 | select medium/high cases |
| social.x.sources default runtime sources + Go toolchain | T1, T4 | select npm / Go module / Go stdlib cases |
| social.x.daily_cap default 10, bounded | T1, T6 | lane cap case |
| qualifies once, first sight only, never on updates | T4, T6 | select update + raised-severity cases |
| deterministic template, <= 280 weighted, 23-char URL | T5 | text.tcs-106 |
| withdrawn never posts | T4, T8 | select withdrawn; replay withdrawn 409 |
| No LLM | T5 | text is a pure function (exact-string tests) |
| POST /2/tweets with OAuth 1.0a, no npm dep | T2, T3 | oauth1.tcs-106; package.json unchanged |
| 4 wrangler secrets (set per comment 6447345509) | T3, T11 | budget (env typed); OPERATING.md |
| one seam src/social/x.ts | T3 | budget grep case |
| fake makes 0 network calls | T3 | budget fetch-spy case |
| contract suite, skipped without secrets, main + nightly | T10 | contract file + workflow |
| 429/5xx cap 3 then failed; 2xx no id → empty terminal | T6 | dedup 500/429/empty cases |
| never log the token; error body <= 200 chars | T3, T6 | dedup 200-char case; code review of log lines |
| runs in existing cron tick after ingestion | T6 | lane runCron case |
| /v1/status social block | T7 | status.tcs-106 |
| OPERATING.md section; replay route, writes nothing on ok | T8, T11 | replay.tcs-106; gen:docs --check |
| docs/API.md status block | T11 | gen:docs --check |
| budget test 0 X calls in PR suite | T3 | budget.tcs-106 |
| billing error = vendor failure in contract suite (comment 6447345509) | T3, T10 | classify.tcs-106 billing rows; contract vendor_failure skip |
| billing in lane does not post twice, ends failed at cap | T6 | dedup 402 case |
| contract posts for real now that credits exist (comment 6447444139) | T10 | contract post+delete case runs when secrets set |
| handle @tocsinagent everywhere, never @tocsin_sh (comment 6447345509) | T11 | grep check `tocsin_sh` count 0 |
| NEGATIVE: never post from Lior's personal account | T3 | seam reads only the X_* secrets of @tocsinagent; no other channel exists |

## Acceptance tests
All in the `api` vitest project (workers pool, D1 + KV, `SOCIAL_TRANSPORT=fake`) except the contract file. Each test seeds its own advisories with unique ids (helpers.tcs-106.ts, via the real `upsertAdvisory` so docs have the production shape, D4) and asserts only the fields this ticket owns.
- `tests/social/select.tcs-106.test.ts`
  - a critical node-runtime advisory created after the watermark qualifies; a second lane run writes no second row (row count 1).
  - a medium node-runtime advisory never qualifies; raising it to critical by a later upsert (same id, new cursor) still writes no row.
  - an advisory whose doc carries `withdrawn` never qualifies.
  - an update (new cursor) to an advisory that already has an `ok` row writes nothing and makes no call.
  - near misses: a critical npm advisory (not a runtime source) → no; a critical OSV `Go` module row (`golang.org/x/net`) → no; a critical OSV `Go` `stdlib` row → yes; a critical advisory with `published_at` older than `max_age_hours` → no; `min_severity=high` makes a high one qualify; an unknown `min_severity` value acts as `critical`.
- `tests/social/dedup.tcs-106.test.ts`
  - two ticks for one advisory → the fake outbox holds exactly 1 call.
  - the row exists with status `sending` and `attempts = 1` at the moment the fake is called (fake mode reads the row inside `post` and records it).
  - mode `empty` → status `empty`, a next tick makes 0 calls.
  - mode `500` three ticks (retry_seconds set to 0 in the test's settings) → `failed` after attempts 3, a 4th tick makes 0 calls; mode `429` same.
  - mode `402` (billing) three ticks → `failed` after attempts 3 with `error` starting `billing:`, and `sources.social-x.last_error` starts `billing:`; a 4th tick makes 0 calls.
  - mode `403` (plain, no billing words) → `failed` after 1 attempt. Mode `network` → `failed`, 1 attempt.
  - a `sending` row past its lease → `failed` `unknown_outcome`, 0 calls.
  - error text is at most 200 chars (fake answers a 1,000-char body).
  - EXPLAIN QUERY PLAN on 1,000 seeded rows: the dedup lookup uses `ux_social_posts_advisory_channel`; the claim uses `idx_social_posts_due`; the cap count uses `idx_social_posts_attempted`; `posted_24h` uses `idx_social_posts_posted`; the retention select uses `idx_social_posts_retention`; the candidate scan uses `idx_advisories_ecosystem_cursor`. None shows a bare `SCAN social_posts`.
- `tests/social/lane.tcs-106.test.ts`
  - `social.x.enabled=0`: 0 rows, 0 calls, watermark moves to `MAX(cursor)`; then enabled=1 with no new advisory → 0 rows (no backlog).
  - enabled with no secrets and the fake transport off is not testable in the pool; instead the lane is called with a `getXClient` that answers null (injected parameter of `runSocialLane`) → 0 rows, `sources.social-x.last_error = 'not_configured'`.
  - daily cap 2 with 3 qualifying advisories → 2 calls, 1 row stays `pending`; the next UTC day (injected `now`) → the 3rd posts.
  - through the production entry point: `runCron` with the `*/10` cron and a stub registry → the lane runs after sweep (1 fake call). Removing the call in run.ts turns this red (D2).
- `tests/social/text.tcs-106.test.ts`
  - Node 2026-10-21 fixture (tests/fixtures/node-runtime/2026-10-21.html through the existing node-runtime ingest fake) → exact expected text, built from the stored doc's own `summary`, `fixed_versions` and id.
  - PHP 2026-10-21 fixture (tests/fixtures/php-runtime/2026-10-21.html + GHSA JSON through runtime-fake.tcs-6) → exact expected text.
  - weighted length <= 280 with the URL at 23; a 200-char summary is cut with `…` and the URL is intact; 12 fixed versions collapse to `+k more`; a CJK character weighs 2.
- `tests/social/oauth1.tcs-106.test.ts`: RFC 5849 §1.2 vector; the header carries every `oauth_*` field; the JSON body is not in the base string.
- `tests/social/classify.tcs-106.test.ts`: `classifyXAnswer` table. Billing side: 402 any body; 403 body `{"title":"CreditsDepleted"}`; 403 body naming `client-not-enrolled`; 403 body with `payment required`. Not billing (near misses): 403 `{"detail":"You are not allowed to create a Tweet with duplicate content."}` → terminal; 401 → terminal; 429 → retryable; 503 → retryable; 400 → terminal; 201 with `data.id` → ok; 201 without `data` → empty; 200 with `data.id: ""` → empty. Source: assumed (X's exact billing body is not in a fixture on this box).
- `tests/social/budget.tcs-106.test.ts`: fake under the binding; 0 `api.x.com` fetches across an enabled lane run and a replay; `npm test` project list excludes `contract`.
- `tests/social/replay.tcs-106.test.ts`: no header 401; wrong token 403; `ok` row → 200 `changed:false` and the row's `updated_at` is unchanged and 0 calls; `failed` row → reset and posted once; enabled=0 → 409, 0 calls; cap full → 429, 0 calls.
- `tests/social/retention.tcs-106.test.ts`: an `ok` row older than 365 days is in the archive and gone from `social_posts`; a `pending` row of the same age stays; a 30-day-old `ok` row stays; dry run moves nothing and audits the count; a re-run is idempotent (archive count unchanged).
- `tests/social/status.tcs-106.test.ts`: `GET /v1/status` has `social.enabled` false by default; after 2 `ok` posts in the last 24 h and 1 older → `posted_24h` 2; `last_error` reads the `social-x` row.
- `tests/contract/social-x.contract.tcs-106.test.ts`: as in the Seam section.

## QA screens
No UI. API checks only: `GET /v1/status` (the `social` block) and `POST /v1/internal/social/replay` (401 without a bearer).

## Design collision check (BH-5791)

Checked 7 listed and 0 derived symbols against main 8d01a5913b01..8d01a5913b01 and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 20
LINES: 950
DIFF_KB: 100

KIND: feature
SIZE: L
