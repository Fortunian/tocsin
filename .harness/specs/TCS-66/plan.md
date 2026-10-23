# Plan: TCS-66 — Watch lists: per-IP limit before API-key auth

Ticket: Fortunian/tocsin#66 (ai-build, open). Blocked-by #8: CLOSED. Thread: 0 comments; the body is the spec.
ALREADY ON MAIN? `git log origin/main --since=2026-10-23T03:58:12Z` shows only 41c4549 (TCS-8, merged before this ticket was filed; it added the per-key limiter, not a pre-auth one). `grep watchlists.ip_rate_per_minute` on main: no hit. Not done.
CodeGraph: NOT AVAILABLE on this box. Files and callers found with grep (`grep -rn "RateLimit\|requireApiKey" src`).

## Spec changes from comments
none

## Scope
A request to `/v1/watchlists/*` with an unknown key today costs one SHA-256 and two D1 reads (AUTH_SQL plus the `auth.last_used_resolution_seconds` setting) with no ceiling (`src/routes/watchlists.ts:46` mounts `requireApiKey, keyRateLimit`; nothing runs before auth).
Add one per-IP limiter, built with the existing `makeRateLimit` (the factory `/v1/check` uses), keyed on `CF-Connecting-IP`, limit from settings row `watchlists.ip_rate_per_minute` (seed 300, code fallback 300). Mount it in `src/app.ts` in front of the `/v1/watchlists` and `/v1/keys` sub-apps. Over the limit: 429, JSON `{error}`, `Retry-After`, `Cache-Control: no-store` (the shared `countAndGate` answer). The per-key limiter stays as the second gate, unchanged.

## ASSUMPTIONS
- The ticket says "the one `/v1/check` uses, settings row `watchlists.ip_rate_per_minute`". `/v1/check` uses `check.anon_rate_per_minute` (20). Assumed: reuse the same factory (`makeRateLimit`) with a NEW row `watchlists.ip_rate_per_minute` = 300, as the ticket names. Other reading: reuse `checkRateLimit` itself (20/min, shared with /v1/check). Rejected: it would cut a valid key's 120/min to 20/min and couple two routes.
- "makes no D1 read" on the 301st request. The limiter reads its own limit from the settings row (rule 5, and the ticket's "the limit is the settings row"), and that is a D1 read. Assumed: the 429 path makes exactly ONE D1 statement, the settings SELECT, and NO statement on `api_keys` or `plans` (no AUTH_SQL, no last_used UPDATE, no `auth.*` setting read). The test pins that exact statement list. Other reading: zero D1 statements, which needs an in-isolate cache of the limit (a new TTL knob and stale-limit semantics). Rejected as scope creep; a follow-up can add it.
- Counter scope `auth` (KV key `rl:v1:auth:<ip>:<minute>`) is ONE budget shared by `/v1/watchlists/*` and `/v1/keys` per IP. The ticket names one row for both routes, so one budget. Other reading: two counters on one row. Either is a one-line change.
- `/v1/keys` already has a per-IP gate (`keysRateLimit`, 5/min) and no `requireApiKey`. Assumed: still mount the new gate there, as the ticket asks; it runs first, `keysRateLimit` stays as is. Cost: one KV get, one KV put, one settings read per `/v1/keys` call.
- Mount in `src/app.ts` with `app.use("/v1/watchlists/*", …)` and `app.use("/v1/keys/*", …)` before the `app.route` lines, NOT in `src/routes/watchlists.ts` (claimed by sibling TCS-11). Hono's `/x/*` also matches `/x`; the test pins the base paths.
- Docs (`docs/API.md` rate list, `docs/RETENTION.md` settings-row list) are claimed by sibling TCS-11. Not edited here; the code comment and migration comment name the row. A docs line is a follow-up NOTE.
- KIND feature (a missing gate found by review, not a wrong behaviour of existing code).

## Sibling claims (not touched)
TCS-11 holds `src/routes/watchlists.ts`, `src/lib/settings.ts`, `docs/API.md`, `docs/RETENTION.md` and a `0017_deliveries.sql` migration. This plan edits none of them. The mount goes in `src/app.ts`; the limit read uses the existing settings reader unchanged. Migration-number note: TCS-11's new migration and this one both follow 0017; whichever merges second renumbers (a [NOTE]-level process item).

## Files to touch
- `src/middleware/ratelimit.ts` — add `FALLBACK_IP_AUTH_RATE_PER_MINUTE = 300` and `authIpRateLimit = makeRateLimit({ settingKey: "watchlists.ip_rate_per_minute", fallback, scope: "auth" })`; add the row to the fallback comment.
- `src/app.ts` — two `app.use` lines before `app.route("/v1/keys", …)` with a one-line comment.
- `migrations/0018_watchlists_ip_rate.sql` — `INSERT OR IGNORE INTO settings (key, value) VALUES ('watchlists.ip_rate_per_minute', '300');`
- `tests/routes/watchlists-ip-limit.tcs-66.test.ts` — new, per-ticket.
- `tests/worker/migrations.tcs-1.test.ts` — append `0018_watchlists_ip_rate.sql` to the pinned list.

## Tests that must change
- `tests/worker/migrations.tcs-1.test.ts`: it pins the exact migration list 0001..0017; this ticket adds 0018.

## Changed symbols
- function `authIpRateLimit` (new export in src/middleware/ratelimit.ts): per-IP gate, scope `auth`, row `watchlists.ip_rate_per_minute`.
- route `* /v1/watchlists/*`: a per-IP 429 now runs before `requireApiKey`.
- route `POST /v1/keys`: the same per-IP 429 runs before `keysRateLimit`. callers: left alone: `keysRateLimit` and `keyRateLimit` unchanged.

## Tasks
T1. Limiter + seed row. Add `authIpRateLimit` and fallback in `src/middleware/ratelimit.ts`; add `migrations/0018_watchlists_ip_rate.sql`; update the pinned list in `tests/worker/migrations.tcs-1.test.ts`.
VALIDATE: npm test -- tests/worker/migrations.tcs-1.test.ts tests/routes/watchlists-ip-limit.tcs-66.test.ts -t "seeds watchlists.ip_rate_per_minute"
SATISFIES: "settings row `watchlists.ip_rate_per_minute`, default 300" / "the limit is the settings row"

T2. Mount before auth. In `src/app.ts`, `app.use("/v1/watchlists/*", authIpRateLimit)` and `app.use("/v1/keys/*", authIpRateLimit)` above the two `app.route` lines.
VALIDATE: npm test -- tests/routes/watchlists-ip-limit.tcs-66.test.ts
SATISFIES: "Mount the existing per-IP limiter … in front of `requireApiKey` on `/v1/watchlists/*` and on `/v1/keys`. 429 with Retry-After."

T3. Acceptance tests in `tests/routes/watchlists-ip-limit.tcs-66.test.ts` (see below), then the full suite and typecheck.
VALIDATE: npm test && npm run typecheck
SATISFIES: "the 301st request from one IP with unknown keys is 429 and makes no D1 read (count statements); a valid key from another IP is unaffected; the limit is the settings row" / "The per-key limiter stays as the second gate."

## Acceptance tests
File `tests/routes/watchlists-ip-limit.tcs-66.test.ts`. Clock pinned 15 s into a minute (pattern of `ratelimit.tcs-3`), so Retry-After = 45. Each test uses its own unique IP (`nextIp()` from `keys-helpers.tcs-8.ts`, or a per-test `2001:db8:66::<n>`) and unique emails; the settings row is reset in `afterEach`. Statement counting: call `app.fetch(req, { ...env, DB: countingDb }, createExecutionContext())` (import `app` from `src/app`), where `countingDb` wraps `env.DB.prepare` / `batch` / `exec` and records each SQL string.
1. `seeds watchlists.ip_rate_per_minute = 300`: SELECT the row, value "300".
2. 300 GETs `/v1/watchlists` from IP X with `Bearer tcs_<64 zeros>` answer 401; the 301st answers 429, `Retry-After: 45`, JSON `{error: string}`; its recorded SQL is exactly `["SELECT value FROM settings WHERE key = ?"]` and none of it names `api_keys` or `plans`. KV `rl:v1:auth:X:<window>` = "300".
3. While X is blocked, a valid key (from `newKey()`) from IP Y answers 200 on `GET /v1/watchlists`; the same valid key from IP X answers 429 (the per-IP gate counts every caller from that IP).
4. Every mounted path is gated before auth: with the counter for IP Z preset to the limit, `GET /v1/watchlists`, `POST /v1/watchlists`, `GET /v1/watchlists/wl_x/events`, `DELETE /v1/watchlists/wl_x` and `POST /v1/keys` each answer 429 with no `api_keys` statement; `GET /v1/events` and `/v1/check` from Z are NOT 429 from this gate (other scopes).
5. The limit is the settings row: row = "2" → 3rd request from a fresh IP is 429; row deleted → fallback 300 (counter preset 299 → 401, next → 429); row "abc" → fallback 300.
6. Per-key gate still second: with `watchlists.key_rate_per_minute` = 1 and the IP limit at 300, a valid key's 2nd call (new IP each call) is 429 and the `rl:v1:auth:` counter of those IPs is 1 (IP gate passed, key gate refused).
7. `/v1/keys` order: with the IP counter preset to the limit, `POST /v1/keys` is 429 and the `rl:v1:keys:<ip>` counter is not written.
Regression risk: `tests/routes/watchlists*.tcs-8.test.ts`, `tests/routes/keys.tcs-8.test.ts` (each call uses its own IP via `nextIp()`, so a 300/IP gate never trips; checked: no test sends >5 calls from one fixed IP to these routes), `tests/routes/ratelimit.tcs-3.test.ts` (other scopes), `tests/worker/migrations.tcs-1.test.ts` (changed above), `tests/launch/*` (drives the worker; uses few calls).

## Verify (run, not edited)
- `npm test`, `npm run typecheck`, `npm run migrate:local`.

## System invariants
None beyond the iron laws. The change reuses the existing KV fixed-window counter and its fail-open-on-write-fault rule; no new table, no new cross-run store beyond one more `rl:v1:auth:` KV key family (TTL 120 s, so it needs no retention job), no external side effect.
- Iron laws: no new table (no index/RLS/retention owed; settings is a fixed key/value table). Limit is a DB row with a documented code fallback (rule 5, BH-7945). No metered call, no LLM, no model id, no UI (sortable headers / cards / drill-down / loading.tsx n/a). Additive migration with INSERT OR IGNORE.
- Perf: the gate adds per request one KV get + one settings read in parallel (Promise.all inside `countAndGate`) and one KV put. A refused unknown-key request drops from 2 D1 statements + SHA-256 to 1 D1 statement. Scalable tests: no vendor touched; tests seed their own IPs/keys, no order dependence.
- Build-discipline rules that bite: per-ticket test file; sibling-file avoidance (`src/routes/watchlists.ts`); TEST-CHANGE line for the migrations test.

## Requirements coverage
| Requirement | Task | Test |
|---|---|---|
| Per-IP limiter before `requireApiKey` on `/v1/watchlists/*` | T2 | AT2, AT4 |
| Same on `/v1/keys` | T2 | AT4, AT7 |
| Settings row `watchlists.ip_rate_per_minute`, default 300 | T1 | AT1, AT5 |
| 429 with Retry-After | T2 | AT2 |
| 301st unknown-key request from one IP is 429, no D1 read on auth | T2 | AT2 |
| Valid key from another IP unaffected | T2 | AT3 |
| Per-key limiter stays second gate | T2 (no change to it) | AT6 |
| Negative: the gate does not touch other routes' budgets | T2 | AT4 (events/check not gated) |

## QA screens
None (API only). Manual probe after deploy: `for i in $(seq 301); do curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer tcs_00' https://tocsin.sh/v1/watchlists; done | sort | uniq -c` → 300×401, 1×429.

```pr-body-requires
TEST-CHANGE: tests/worker/migrations.tcs-1.test.ts <- Tests that must change
## ASSUMPTIONS <- plan ASSUMPTIONS section
```

## Design collision check (BH-5791)

Checked 3 listed and 0 derived symbols against main 41c4549a09d1..41c4549a09d1 and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 3
LINES: 25
DIFF_KB: 9

KIND: feature
SIZE: S
