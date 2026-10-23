# TCS-83 plan: atomic send caps in D1; documented mail deploy prerequisites

Ticket: Fortunian/tocsin#83, "API keys follow-ups: atomic send caps; documented mail deploy prerequisites".
Blocked-by: #64 (hard). #64 is CLOSED (merged as 385df55, PR #70). The ticket is buildable.

Already on main? `git log origin/main --since=2026-10-23T19:56:20Z` shows f1b4f68 (TCS-11), 624d4d1 (zod override), 385df55 (TCS-64).
None of them moves the send counters out of KV or adds docs/OPERATING.md or a `keys-signup` check.
`src/routes/keys.ts` on main still does `kv.get` of `rl:v1:keyssend:*` and `mail:sent:<day>` and `bump()` with `kv.put`. Nothing is done yet.

CodeGraph: NOT AVAILABLE on this box. Callers and dependents below come from grep.

## Spec changes from comments
none

(The issue has 0 comments. The body is the whole spec.)

## Scope

1. Move the three mail send caps (per IP per hour, per email per hour, per UTC day) from KV read-then-put to one D1 table with one atomic reserve step BEFORE the provider call.
2. Delete counter rows older than 2 days in the nightly (daily) cron. The window is a settings row.
3. A test sends 50 parallel `POST /v1/keys` against a cap of 10 and proves at most 10 sends.
4. New `docs/OPERATING.md`: the one-time mail deploy steps (secret, domain-lockdown TXT, SPF, DKIM, settings rows) and the launch-check line.
5. `scripts/launch-check.sh` gains a `keys-signup` check (POST /v1/keys answers 202 for a test address), off by default behind an env switch.

Out of scope: the mail seam (`src/mail/send.ts`, `src/mail/fake.ts`), the confirm flow, the per-minute `keysRateLimit` middleware (KV, TCS-66), the GitHub workflow.

## Design (decided here)

### Table `send_counters` (migration `migrations/0024_send_counters.sql`)

```sql
CREATE TABLE IF NOT EXISTS send_counters (
  window_key TEXT PRIMARY KEY,   -- 'ip:<ip>:<hour>' | 'em:<sha256 email>:<hour>' | 'day:<YYYY-MM-DD>'
  n INTEGER NOT NULL DEFAULT 0,  -- mails reserved in this window
  created_at TEXT NOT NULL       -- ISO time of the first reserve; the retention clock
);
CREATE INDEX IF NOT EXISTS idx_send_counters_created_at ON send_counters (created_at);
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.send_counters_days', '2');
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.send_counters_batch', '5000');
INSERT OR IGNORE INTO settings (key, value) VALUES ('retention.send_counters_dry_run', '0');
```

- Additive only. D1 (SQLite), not Supabase: RLS does not apply.
- `<hour>` is `Math.floor(now / HOUR_MS)`, `<day>` is the UTC date: the same window values the KV keys use today.
- Index use: the reserve, refund and snapshot statements use the primary key (`sqlite_autoindex_send_counters_1`). The retention delete and dry-run count use `idx_send_counters_created_at`.

### Reserve (new file `src/mail/send-caps.ts`)

One `env.DB.batch([...])` (one D1 transaction, writes serialized by D1):

1. `INSERT INTO send_counters (window_key, n, created_at) VALUES (?1, 0, ?4), (?2, 0, ?4), (?3, 0, ?4) ON CONFLICT(window_key) DO NOTHING`
2. The conditional increment (`RESERVE_UPDATE_SQL`):

```sql
WITH over AS MATERIALIZED (
  SELECT COUNT(*) AS c FROM send_counters
  WHERE (window_key = ?1 AND n >= ?5) OR (window_key = ?2 AND n >= ?6) OR (window_key = ?3 AND n >= ?7))
UPDATE send_counters SET n = n + 1
WHERE window_key IN (?1, ?2, ?3) AND (SELECT c FROM over) = 0
RETURNING window_key, n
```

   ?1 ip key, ?2 email key, ?3 day key, ?4 now ISO, ?5 ip cap, ?6 email cap, ?7 day cap.
3. `SELECT window_key, n FROM send_counters WHERE window_key IN (?1, ?2, ?3)`: the snapshot for the refusal answer.

Exports: `RESERVE_INSERT_SQL`, `RESERVE_UPDATE_SQL`, `SNAPSHOT_SQL`, `REFUND_SQL`, and
`reserveSend(db, keys, caps, nowIso): Promise<{ reserved: true } | { reserved: false; ipOrEmailFull: boolean; dayFull: boolean }>` and
`refundSend(db, keys): Promise<void>`.

Rules:
- Reserved only when statement 2 returns exactly 3 rows. If it returns 1 or 2 rows (not possible by design), refund those rows, log `{lane:"mail", err:"partial reserve"}` and answer refused. So no partial count can stay.
- 0 rows: refused. `ipOrEmailFull` = the snapshot ip row n >= ipCap OR email row n >= emailCap. `dayFull` = day row n >= dayCap.
- A cap of 0 refuses every send (n >= 0 is true). That matches the KV code today (`count >= cap`).
- Refund: `UPDATE send_counters SET n = n - 1 WHERE window_key IN (?1, ?2, ?3) AND n > 0`. A refund fault is logged (`step:"refund"`), not raised.

### New order in `sendConfirmLink` (`src/routes/keys.ts`)

1. Parse and validate the body (unchanged).
2. Read the 7 settings in one `Promise.all` (unchanged list). Drop the 3 KV counter reads.
3. `getMailer` null: 503 `mail_not_configured` (unchanged, still before any reserve, so a not-configured box counts nothing).
4. `reserveSend`. Refused and `ipOrEmailFull`: 429 with the same body and `Retry-After` as today. Else refused and `dayFull`: 503, `daily_send_cap_hit` alert line, `Retry-After` to the next UTC midnight (as today). The 429 check comes first, as today.
5. Key lookup, token put, send (unchanged).
6. Send throws: delete the token (as today), `refundSend`, answer 502. So a failed send leaves the counters unchanged (pins the existing TCS-64 test "a failed send ... leaves the counters unchanged").
7. Send ok: answer 202. Delete the `bump()` function and the KV counter keys.

Write-vs-send ordering: the reserve commits BEFORE the provider call, so a send can never happen without its count (dedup before spend, CLAUDE.md rule 7). A throw between reserve and send (key lookup or token put) answers 500 and leaves the slot counted: an over-count, which is the safe side of a spend cap.

### Retention (new file `src/cron/send-counters-retention.ts`)

`runSendCounterRetention(env, now)`, the same shape as `src/cron/deliveries-retention.ts`:
- Knobs: `retention.send_counters_days` (fallback 2), `retention.send_counters_batch` (fallback 5000), `retention.send_counters_dry_run` (fallback 0). `FALLBACK_*` constants with a comment that names each row.
- `days < 1` or `batch < 1`: log and throw (as the other two jobs do).
- Delete: `DELETE FROM send_counters WHERE rowid IN (SELECT rowid FROM send_counters WHERE created_at < ?1 LIMIT ?2)` (`SEND_COUNTER_RETENTION_SQL`).
- Dry run (any value but 0): `SELECT COUNT(*) AS n FROM send_counters WHERE created_at < ?1`, delete nothing.
- Audit: KV `retention:send_counters:last` = `{ran_at, cutoff, dry_run, deleted, has_more}`, written after the delete commits, plus one log line `{lane:"retention", table:"send_counters", ...}`.
- A live window is never deleted: the longest window is one UTC day, and the minimum retention is 1 day after `created_at`.

Wiring (`src/cron/run.ts`): in the `DELIVERY_RETENTION_CRON` (`41 4 * * *`) branch, run `runDeliveryRetention` and `runSendCounterRetention` with `Promise.allSettled`, then rethrow the first rejection. So one job's fault does not skip the other, and the cron still fails loud. No new cron string, no `wrangler.toml` change.

### docs/OPERATING.md (new) and README pointer

One-time operator steps, numbered, each one a verb first (STE):
1. `wrangler secret put MAILCHANNELS_API_KEY` (the name `src/env.ts` and `getMailer` read).
2. Domain lockdown TXT record `_mailchannels.tocsin.sh` with the value MailChannels documents (`v=mc1 auh=<MailChannels account id>`). The account id is a placeholder, never a guessed value (D26).
3. SPF TXT on `tocsin.sh` with `include:relay.mailchannels.net`.
4. DKIM for `keys@tocsin.sh` as MailChannels documents it. The builder MUST read the MailChannels docs page (WebFetch) and link it. If MailChannels signs only when the request carries DKIM fields that `src/mail/send.ts` does not send today, OPERATING.md says so as an open gap line, and the PR body says so. No seam code change in this ticket.
5. The settings rows the route reads, with seed values: `keys.confirm_ttl_seconds`, `keys.ip_sends_per_hour`, `keys.email_sends_per_hour`, `mail.daily_send_cap`, `mail.provider`, `mail.from_address`, `keys.confirm_base_url`, `keys.max_body_bytes`, `keys.anon_rate_per_minute`, `watchlists.ip_rate_per_minute`, plus the 3 new retention rows. Migrations seed them; the step is "check them with `wrangler d1 execute DB --remote --command "SELECT key, value FROM settings WHERE key LIKE 'keys.%' OR key LIKE 'mail.%'"`".
6. Run `KEYS_CHECK=1 KEYS_CHECK_EMAIL=<an inbox you own> bash scripts/launch-check.sh` once and confirm `ok keys-signup` (202, not 503).

README "Self-host": one line that points to docs/OPERATING.md for mail.

### launch-check `keys-signup`

- New switch `KEYS_CHECK` (default unset, off) and `KEYS_CHECK_EMAIL` (no default).
- `KEYS_CHECK=1` and `KEYS_CHECK_EMAIL` empty: `FAIL preflight: KEYS_CHECK_EMAIL must be set when KEYS_CHECK=1`, exit 1.
- The check POSTs `{"email": "<KEYS_CHECK_EMAIL>"}` (built with `jq -n --arg`) to `/v1/keys`. `ok keys-signup` only on HTTP 202 with a JSON body whose `.status == "sent"`. Else `FAIL keys-signup: POST /v1/keys: HTTP <code>` (a 503 says "mail not configured or daily cap hit").
- TOTAL is 5, plus 3 with COVERAGE_CHECK=1, plus 1 with KEYS_CHECK=1. The header comment lists the new check and env.
- The existing `post_check` answers only 200, so `keys-signup` gets its own small function or a code argument. The existing checks do not change.

## Files to touch

- `migrations/0024_send_counters.sql` (new)
- `src/mail/send-caps.ts` (new)
- `src/routes/keys.ts`
- `src/cron/send-counters-retention.ts` (new)
- `src/cron/run.ts`
- `scripts/launch-check.sh`
- `docs/OPERATING.md` (new)
- `docs/RETENTION.md`
- `README.md`
- `tests/routes/keys-caps.tcs-83.test.ts` (new)
- `tests/routes/keys-caps-plan.tcs-83.test.ts` (new)
- `tests/cron/send-counters-retention.tcs-83.test.ts` (new)
- `tests/launch/launch-keys.tcs-83.test.ts` (new)
- `tests/worker/migrations.tcs-1.test.ts`

## Tests that must change

- `tests/worker/migrations.tcs-1.test.ts`: it pins the applied migration list as exactly 0001..0023; this ticket adds `0024_send_counters.sql`.

## Changed symbols

- function `sendConfirmLink` (src/routes/keys.ts): the caps move from KV get/put to `reserveSend`/`refundSend` in D1; the answer codes, bodies and `Retry-After` stay the same.
- function `bump` (src/routes/keys.ts): deleted. callers: only `sendConfirmLink`.
- function `reserveSend`, `refundSend` (src/mail/send-caps.ts): new.
- function `runSendCounterRetention` (src/cron/send-counters-retention.ts): new.
- function `runCron` (src/cron/run.ts): the `41 4 * * *` branch also runs the send-counter retention.
- route `POST /v1/keys`, `POST /v1/keys/rotate`: same contract; the cap is now atomic.
- format `send_counters` table and KV `retention:send_counters:last` audit record: new.
- verb `scripts/launch-check.sh`: new `keys-signup` check, new env `KEYS_CHECK`, `KEYS_CHECK_EMAIL`; TOTAL changes only when `KEYS_CHECK=1`.

## Sibling claims (not touched)

`/root/harness/state/claims/tocsin/` is empty at plan time. Open PR #79 (TCS-38) also edits `tests/worker/migrations.tcs-1.test.ts` and adds a migration numbered 0021. That is a merge-order conflict on one line of the migration list, not a design collision; the second PR to merge rebases its list.

## Design collisions

- `POST /v1/keys`: combine. PR #79 (e4efb1bc0ade, TCS-38) matches only as text: it regenerates the one-line `DOCS_HTML` string in `site/docs.generated.ts` for its `/v1/check` doc edits, and the `POST /v1/keys` rows in that string are byte-identical before and after. It changes no keys route code and no keys contract, and this plan keeps the same codes, bodies and `Retry-After` and edits neither `docs/API.md` nor `site/docs.generated.ts`, so the two designs combine with no change.

## Tasks

### T1. Migration 0024 and the reserve/refund module
Create `migrations/0024_send_counters.sql` and `src/mail/send-caps.ts` as designed above.
VALIDATE: npm test -- tests/routes/keys-caps-plan.tcs-83.test.ts
SATISFIES: "Move the counters to D1 (`UPDATE ... SET n = n + 1 WHERE n < cap RETURNING n`, one row per window key ...)"

### T2. Use the reserve in sendConfirmLink
Edit `src/routes/keys.ts` per the "New order" list. Delete `bump`, the KV counter reads and the `ipKey`/`emailKey`/`dayKey` KV names (the window strings move to D1 keys).
VALIDATE: npm test -- tests/routes/keys-caps.tcs-83.test.ts tests/routes/keys-confirm.tcs-64.test.ts tests/routes/keys-budget.tcs-64.test.ts tests/routes/keys.tcs-8.test.ts
SATISFIES: "the check stays BEFORE the provider call; a test runs 50 parallel requests against a cap of 10 and proves at most 10 sends."

### T3. Retention job and cron wiring
Create `src/cron/send-counters-retention.ts`; wire it into the `41 4 * * *` branch of `src/cron/run.ts` with `Promise.allSettled`.
VALIDATE: npm test -- tests/cron/send-counters-retention.tcs-83.test.ts tests/cron/deliveries-retention.tcs-11.test.ts tests/cron/run.tcs-2.test.ts
SATISFIES: "retention: rows older than 2 days deleted by the nightly job"

### T4. launch-check keys-signup
Edit `scripts/launch-check.sh` per the design.
VALIDATE: npm test -- tests/launch/launch-keys.tcs-83.test.ts tests/launch/launch-check.tcs-14.test.ts
SATISFIES: "`scripts/launch-check.sh` gains `keys-signup` (202 with a test address) behind the existing env switch."

### T5. docs/OPERATING.md, README pointer, RETENTION.md
Write `docs/OPERATING.md`. Add the README Self-host pointer line. In `docs/RETENTION.md`, replace the KV send-counter paragraph with a `## send_counters` section (what a row is for, 2-day window row, daily cron, batch, dry run, deleted not archived because it is a rate counter, not money) and a `## KV retention:send_counters:last` section; add the 3 new rows to the settings list.
VALIDATE: grep -c "wrangler secret put MAILCHANNELS_API_KEY\|_mailchannels\|include:relay.mailchannels.net\|DKIM\|keys-signup" docs/OPERATING.md (5 or more lines) && grep -n "send_counters" docs/RETENTION.md && ! grep -n "rl:v1:keyssend\|mail:sent" docs/RETENTION.md src/routes/keys.ts
SATISFIES: "Deploy prerequisites, as a documented one-time operator step in docs/OPERATING.md ... plus a launch-check line that `POST /v1/keys` answers 202 (not 503) in production once set."

### T6. Migration list test
Add `"0024_send_counters.sql"` to the list in `tests/worker/migrations.tcs-1.test.ts` and rename the case to "applies 0001..0024". Nothing else in that file changes.
VALIDATE: npm test -- tests/worker/migrations.tcs-1.test.ts
SATISFIES: "Move the counters to D1" (the new migration must apply on a fresh D1).

## Acceptance tests

`tests/routes/keys-caps.tcs-83.test.ts` (api project, production entry point via `call()` from keys-helpers.tcs-8, fake mailer, fake `Date` per test so window keys are unique per test):
- C1 parallel burst: set `mail.daily_send_cap=10`, `keys.ip_sends_per_hour=1000`, `keys.email_sends_per_hour=1000`. Send 50 `POST /v1/keys` with `Promise.all`, 50 unique emails, 50 IPs. Assert exactly 10 answer 202, 40 answer 503, the fake outboxes hold 10 mails in total, and the `day:<date>` row has n = 10. (Before the change the KV read-then-put lets more than 10 through: the red run.)
- C2 parallel burst on the per-IP cap: one IP, `keys.ip_sends_per_hour=10`, 50 parallel requests with unique emails. Assert 10 answer 202, 40 answer 429, 10 mails.
- C3 no partial count: put the ip row at its cap (n = cap) with the day row below cap. One request answers 429, and the day and email rows did not move.
- C4 boundary: the ip row at cap - 1. One request answers 202 and all 3 rows move by exactly 1. The next one answers 429.
- C5 a failed send (`mail.from_address=fail@fake.test`) answers 502 and all 3 rows are back to their values before the request.
- C6 an unknown `mail.provider` answers 503 and writes no `send_counters` row.
- C7 the route makes 0 `CURSORS.get`/`put` calls on any `rl:v1:keyssend:` or `mail:sent:` key (spy on the KV binding), so the KV counters are gone.
- C8 a cap of 0 refuses every send (429 for ip/email 0, 503 for day 0).

`tests/routes/keys-caps-plan.tcs-83.test.ts` (EXPLAIN QUERY PLAN on 5,000 seeded `send_counters` rows):
- P1 `RESERVE_UPDATE_SQL` searches `send_counters` by the primary key (`SEARCH send_counters USING INDEX sqlite_autoindex_send_counters_1` or `USING PRIMARY KEY`), no bare `SCAN send_counters`.
- P2 `SNAPSHOT_SQL` and `REFUND_SQL` the same.
- P3 `SEND_COUNTER_RETENTION_SQL` and the dry-run count use `idx_send_counters_created_at`.
- P4 the 3 retention settings rows exist with seed values `2`, `5000`, `0`.

`tests/cron/send-counters-retention.tcs-83.test.ts`:
- R1 rows with `created_at` 3 days old are deleted, rows 1 day old stay (default window 2).
- R2 `retention.send_counters_days=5` keeps the 3-day rows.
- R3 dry run (`retention.send_counters_dry_run=1`) deletes nothing and the audit says `dry_run: true` with the count.
- R4 `retention.send_counters_batch=2` deletes 2 of 5 old rows and the audit has `has_more: true`.
- R5 the audit KV `retention:send_counters:last` is written after the delete; `days=0` throws and writes no audit.
- R6 through `runCron` with cron `41 4 * * *`: both deliveries retention and send-counter retention run; a throw in one still runs the other and `runCron` rejects.

`tests/launch/launch-keys.tcs-83.test.ts` (local worker from `startLocalWorker({ text: { MAIL_TRANSPORT: "fake" } })`):
- K1 `KEYS_CHECK=1 KEYS_CHECK_EMAIL=launch-<uuid>@example.test`: `ok keys-signup`, `launch-check: 6 of 6 passed`, exit 0.
- K2 the worker answers 503 (no `MAIL_TRANSPORT` and no key bound): `FAIL keys-signup: ... HTTP 503`, exit 1.
- K3 `KEYS_CHECK=1` with no `KEYS_CHECK_EMAIL`: `FAIL preflight`, exit 1.
- K4 without `KEYS_CHECK`: no `keys-signup` line, `5 of 5 passed` (the default run does not POST).

Regression risk (existing suites): `tests/routes/keys-confirm.tcs-64.test.ts` (429/503/502 answers and the "counters unchanged after a failed send" case), `tests/routes/keys-budget.tcs-64.test.ts` (0 fetch calls), `tests/routes/keys.tcs-8.test.ts`, `tests/routes/watchlists*.test.ts` (they call `newKey()`), `tests/cron/run.tcs-2.test.ts`, `tests/cron/deliveries-retention.tcs-11.test.ts`, `tests/launch/launch-check.tcs-14.test.ts`, `tests/launch/launch-coverage.tcs-32.test.ts`, `tests/worker/migrations.tcs-1.test.ts`.

## Verify (run, not edited)

- `npm test`
- `npm run typecheck`
- `npm run migrate:local`

## Failure modes

The plan changes no file under bin/ or worker/. The gate asks for this section because `tests/worker/migrations.tcs-1.test.ts` has a `worker/` part in its path. The answers below cover the reserve gate, the send path and the retention job.
- Decision rule: the reserve gate sends only when all 3 window rows are below their caps. Must NOT send: ip row at cap with day below (C3); email row at cap with ip and day below (C3 variant); day row at cap with ip and email below (C1); any cap 0 (C8); 40 of 50 parallel requests at cap 10 (C1, C2). Must send: all 3 rows at cap - 1 (C4); hour-H ip and email rows at cap with a request in hour H+1 (C4 variant, fake `Date`). Near miss: a statement 2 result of 1 or 2 rows is a refusal with a refund, never a send (source: assumed, not reachable by design). Test: C1 to C4 and C8 in `tests/routes/keys-caps.tcs-83.test.ts`.
- Exit paths: 400 bad body and 503 `mail_not_configured` exit before the reserve and touch no counter; 429 and 503 `daily_send_cap_hit` reserve nothing (the update returns 0 rows); 502 send throw deletes the token and refunds all 3 rows; 500 after the reserve (key lookup or token put throws) leaves the slot counted, an over-count on the safe side of a spend cap; 202 keeps the count; a refund fault is logged and leaves the count. Retention: `days < 1` or `batch < 1` throws before any delete and writes no audit. Test: C5, C6, C3 in `tests/routes/keys-caps.tcs-83.test.ts`, R5 in `tests/cron/send-counters-retention.tcs-83.test.ts`.
- Writer/reader round-trip: new format 1, `send_counters.window_key` (`ip:<ip>:<hour>`, `em:<sha256 email>:<hour>`, `day:<YYYY-MM-DD>`). Writer: `reserveSend`. Readers: the reserve update, `SNAPSHOT_SQL`, `refundSend`, the test assertions. New format 2, `send_counters.created_at` (ISO). Writer: the reserve insert. Reader: the retention cutoff compare. New format 3, KV `retention:send_counters:last`. Writer: `runSendCounterRetention`. Reader: the R tests and the operator. Test: C4 (reserve then snapshot reads the same keys), C5 (reserve then refund), R1 (reserve-shaped `created_at` then retention cutoff), R3 and R5 (audit write then read).
- Alert or freeze blast radius: one existing alert line, `daily_send_cap_hit`, keeps its scope (one line per refused request after the day cap, the same as the KV code today). New log lines: `{lane:"mail", err:"partial reserve"}` (worst case 0 per tick, not reachable by design), `step:"refund"` (at most one per failed send, bounded by the day cap of 500), and one retention log line per daily run. No freeze. Test: C1 (40 refusals give 40 `daily_send_cap_hit` lines, not more), R5.
- Defaults in prod: `retention.send_counters_days=2` (the ticket's value, and longer than the longest window of 1 UTC day); `retention.send_counters_batch=5000` and `retention.send_counters_dry_run=0` (the same values as the two other retention jobs, so the job deletes in prod and is not a shadow run). `KEYS_CHECK` is unset in prod CI, so the default launch-check run sends no mail. The caps keep their existing rows. Test: P4 in `tests/routes/keys-caps-plan.tcs-83.test.ts`, K4 in `tests/launch/launch-keys.tcs-83.test.ts`.
- Status evidence: `ok keys-signup` prints only on HTTP 202 with a JSON body whose `.status == "sent"`; any other code prints `FAIL keys-signup` and exits 1. The retention audit `deleted` is the change count the D1 delete returns, written after the delete commits; a dry run says `dry_run: true` with the count and deletes nothing. Test: K1, K2 in `tests/launch/launch-keys.tcs-83.test.ts`, R3 and R4 in `tests/cron/send-counters-retention.tcs-83.test.ts`.

## System invariants

(a) Cross-run state: table `send_counters`, natural unique key `window_key` (PRIMARY KEY). The reserve is one D1 batch (one transaction), so two parallel requests can never both read the same n. The old KV counter keys expire on their own TTL (at most 2 days for `mail:sent:<day>`); nothing reads them after the deploy. On deploy day the D1 day counter starts at 0, so up to one extra day cap of mails can go out that day. That is a one-time edge, accepted and written in the PR body.
(b) Side effects. Mail send (metered): the reserve commits before the call. Success: 202, count stays. Failure (provider throws): token deleted, count refunded, 502. Not configured (`getMailer` null): 503 before any reserve, nothing counted. Refund fault: logged, count stays (over-count). "Sent without a count" is impossible by construction, because the send runs only after a committed reserve of 3 rows.
(c) Negative list for the reserve gate (must NOT send): ip at cap with day below; email at cap with ip and day below; day at cap with ip and email below; any cap 0; 50 parallel at cap 10 (40 must not send). Must send: all three rows at cap - 1; rows of the previous hour at cap (a new hour key starts at 0). Tests C1 to C4 and C8 cover these. One more case: the ip and email rows of hour H at cap and a request in hour H+1 answers 202 (C4 variant, fake `Date`).
(d) Neighbors: the `41 4 * * *` cron already runs deliveries retention; `Promise.allSettled` keeps the two independent. The `keysRateLimit` per-minute KV limiter (TCS-66) runs before the route and is not changed. The `*/10` ingest cron and `17 3 1 * *` key retention do not read `send_counters`. D1 write load: one batch of 3 statements per send, at most the daily cap (500) per day.

## Requirements coverage

| Requirement (ticket line) | Task | Test |
|---|---|---|
| Counters out of KV read-then-put (negative: no more KV counters) | T2 | C7 |
| Counters in D1, one row per window key, `n = n + 1 WHERE n < cap RETURNING n` | T1, T2 | C1, C3, C4, P1 |
| Check stays BEFORE the provider call | T2 | C1 (outbox count), C6 |
| 50 parallel requests against a cap of 10, at most 10 sends | T2 | C1, C2 |
| Retention: rows older than 2 days deleted by the nightly job | T1 (row), T3 | R1 to R6 |
| Index and EXPLAIN proof for every query on the new table (repo iron rule 2) | T1 | P1 to P3 |
| OPERATING.md: mail provider secret with `wrangler secret put` | T5 | T5 VALIDATE grep |
| OPERATING.md: MailChannels domain-lockdown TXT on tocsin.sh | T5 | T5 VALIDATE grep |
| OPERATING.md: SPF and DKIM for keys@tocsin.sh | T5 | T5 VALIDATE grep |
| OPERATING.md: the settings rows the route reads | T5 | manual read in review |
| OPERATING.md: launch-check line that POST /v1/keys answers 202, not 503 | T5, T4 | K1, K2 |
| launch-check `keys-signup`, 202 with a test address, behind an env switch | T4 | K1 to K4 |

## QA screens

No browser screen. The change is an API route and a cron.
- `POST https://tocsin.sh/v1/keys` with a real inbox: 202, one mail. (Needs the prod mail secret; `[NOTE] not verified here`.)
- The Confirm page `GET /v1/keys/confirm?token=...` is not changed.

## Entry points

no user-facing entry point (an API cap and a cron behind the existing `POST /v1/keys`; the route and its docs already exist).

## Vendors touched

- Mail (MailChannels): seam `src/mail/send.ts` (not changed), fake `src/mail/fake.ts` (not changed), contract test `tests/contract/mail.contract.tcs-64.test.ts` (not changed). The new tests use the fake only. K1 uses the fake through the `MAIL_TRANSPORT=fake` text binding.

## Iron laws that apply

- Indexes and EXPLAIN: P1 to P3 on 5,000 seeded rows.
- Retention: T3, window in `retention.send_counters_days`, dry run, one audit record per run. Rate counters are not money or history, so they are deleted, not archived.
- Knobs: the 3 new limits are settings rows with documented code fallbacks. The caps stay the existing rows.
- Dedup before spend: the reserve is the persisted check before the metered send.
- No per-row correlated subquery: the CTE is uncorrelated and MATERIALIZED, over at most 3 primary-key rows.
- RLS: not applicable (D1).
- UI laws (sortable headers, cards, drill-down, De-AI): not applicable, no UI and no LLM text.
- Build discipline rules that bite: D1 (C1 must be red on the old code), D2 (tests through `exports.default.fetch`), D6 (true exit codes), D9 (refund on the failure path only, 502 never counted as sent), D12/D21 (retention batch cap and `has_more`), D20 (additive migration), D26 (no guessed MailChannels account id or DKIM value in docs), D5 (OPERATING.md states only what the code and MailChannels docs say).

## Performance

Reads on the send path: 7 settings reads in one `Promise.all` (unchanged), then 1 D1 batch (3 statements), then the key lookup, then the token put. Before: 7 settings + 3 KV reads in parallel, then the lookup, put, send and 3 KV puts. Statement count on D1 goes from 8 to 11 per send (+3, the reserve batch); KV ops go from 7 to 1. This is not a key screen and not a perf ticket. No loading skeleton (no UI).

## ASSUMPTIONS

- "Behind the existing env switch": the only switch today is `COVERAGE_CHECK`, which the nightly workflow sets after the backfill. Assumed: a new switch `KEYS_CHECK=1` plus `KEYS_CHECK_EMAIL`, so the coverage run never starts to send real mail. Other reading: put `keys-signup` under `COVERAGE_CHECK=1`, which would mail every night.
- The GitHub workflow `.github/workflows/launch-check.yml` is not changed. The check is a one-time operator run (OPERATING.md step 6). Other reading: wire `vars.KEYS_CHECK_ENABLED` into the workflow.
- D1 table, not a Durable Object (the ticket allows either). D1 is already bound; a Durable Object adds a binding and a migration class.
- A failed send refunds its slot, because the existing TCS-64 test pins "a failed send ... leaves the counters unchanged". Other reading: count every attempt.
- "Nightly job" is the existing daily `41 4 * * *` cron. No new cron string.
- The window keys keep the client IP in clear text, as the KV key names did. Rows are deleted after 2 days.
- DKIM: documented as MailChannels documents it; if signing needs request fields the seam does not send, that is written as an open gap and not built here.

KIND: feature

## Design collision check (BH-5791)

Checked 8 listed and 0 derived symbols against main f1b4f68a4cf0..f1b4f68a4cf0 and 1 open PRs.
- `POST /v1/keys` (function, listed): PR #79 e4efb1bc0ade, (text match). Resolution: combine.

## Size
FILES: 6
LINES: 330
DIFF_KB: 45

SIZE: M
