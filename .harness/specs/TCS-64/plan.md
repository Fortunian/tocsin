# TCS-64 plan: API keys prove email ownership with a one-time link; no enumeration; rotate

Ticket: Fortunian/tocsin#64 (label ai-build, OPEN). Blocked-by #8: CLOSED. Thread: 0 comments, so the body is the spec.
Already on main? `git log origin/main --since=2026-10-23T03:48:53Z` shows 41c4549 and 0fe8f34 only. 41c4549 (TCS-8 round 2) added the body cap and rate limit on `POST /v1/keys`. It did not add a confirm link, a mail seam or rotate. Nothing of this ticket is on main.
CodeGraph: NOT AVAILABLE on this box. Callers and dependents below come from grep (`grep -rn "v1/keys\|newKey\|keysRateLimit\|getSettingInt"`).
No CROSS-REPO-READ.

## Spec changes from comments
none

## Scope
1. `POST /v1/keys {email}` no longer answers a key. It stores a one-time token in KV (TTL from a settings row, 3600 s) and sends a link to the email through one mail seam (`src/mail/send.ts`). It answers 202 with one fixed body, for a new email and for a registered email alike. No 409.
2. `GET /v1/keys/confirm?token=...` consumes the token once. It answers 200 `{key, key_id, plan, email}` with the plaintext key. A used, unknown or expired token answers 410.
3. `POST /v1/keys/rotate {email}` sends a confirm link with rotate copy. Opening it replaces the key hash of that email in place (same `key_id`, plan and watch lists). The old key answers 401 after that.
4. Rate limits on the send: per IP per hour and per email per hour (settings rows), plus the existing per-IP per-minute row `keys.anon_rate_per_minute`. A daily send cap (settings row). When the cap is hit, the worker writes one alert log line.
5. Mail provider is a settings row `mail.provider` (`mailchannels`). Sender is a settings row `mail.from_address`. The first adapter is the MailChannels Email API. In tests the seam returns a fake: 0 network calls.

## Design (decided here, not by the builder)

Token: 32 random bytes as hex (`tct_<64 hex>`). KV key `keyconfirm:v1:<sha256(token)>`. Value JSON `{email, purpose: "create"|"rotate", expect_hash: string|null, expires_at}`. `expect_hash` is the email's `api_keys.key_hash` at send time (null when the email has no key). KV `expirationTtl` = max(60, ttl). `expires_at` is also checked against `Date.now()`, so a test can move the clock.

Single use (KV is not atomic): the confirm does KV get, then KV delete, then a compare-and-swap write in D1:
- `expect_hash` null: `INSERT INTO api_keys (...) VALUES (...) ON CONFLICT(email) DO NOTHING RETURNING id, plan`. No row: 410.
- `expect_hash` set: `UPDATE api_keys SET key_hash = ?new, last_used_at = ?now WHERE email = ? AND key_hash = ?expect RETURNING id, plan`. No row: 410.
So two concurrent opens of one link, or two links sent before the first is used, give one key and one 410. The confirm for a registered email always works as a rotate. That is the recovery path the ticket asks for.

POST /v1/keys and POST /v1/keys/rotate share one handler `sendConfirmLink(c, purpose)`. Order:
1. Body cap (existing `keys.max_body_bytes`), JSON parse, email normalize (trim + lower-case, existing `EMAIL_RE`, 254 max). 400 on a bad body.
2. Read knobs in one `Promise.all` (see Reads). Resolve the mailer from `mail.provider`. Not configured (no `MAILCHANNELS_API_KEY`, or an unknown provider): 503 `{error: "key sign-up is not available right now"}` + one `console.error` alert line `{lane:"mail", alert:"mail_not_configured", provider}`. No token is written.
3. Per-IP hour counter `rl:v1:keyssend:ip:<ip>:<hour>` vs `keys.ip_sends_per_hour` (10). Per-email hour counter `rl:v1:keyssend:em:<sha256(email)>:<hour>` vs `keys.email_sends_per_hour` (3). Over either: 429 + `Retry-After` (to the next hour). The per-email 429 is the same for a registered and a new email, so it tells nothing about registration.
4. Daily counter `mail:sent:<YYYY-MM-DD>` vs `mail.daily_send_cap` (500). At or over: 503 + `Retry-After` (to 00:00Z) + one alert line `{lane:"mail", alert:"daily_send_cap_hit", sent, cap}`. This is the dedup-before-spend check: the persisted counter is read before the metered send.
5. `SELECT key_hash FROM api_keys WHERE email = ?` (idx_api_keys_email).
6. KV put token. Then send. Write before send, so a sent link always has a token.
7. Send ok: increment both hour counters and the daily counter (KV, 2-day TTL for the daily key, 7200 s for hour keys). Answer 202 `{"status": "sent", "expires_in_seconds": <ttl>}` with `Cache-Control: no-store`. The body never depends on the email.
8. Send failed (non-2xx or throw): delete the token (best effort), log `{lane:"mail", err, status}`, answer 502 `{error: "could not send the email, try again"}`. Counters are not incremented. The failure does not depend on registration, so it does not enumerate.

Link: `<keys.confirm_base_url>/v1/keys/confirm?token=<token>`. The base URL is a settings row (default `https://tocsin.sh`), never the request Host header.
Mail text (deterministic, plain, no LLM): subject "Your Tocsin API key link". Body for create: "Open this link within 60 minutes to get your Tocsin API key: <link>. If you did not ask for a key, ignore this email." Rotate/registered: "Open this link within 60 minutes to replace the API key for this email. The old key stops working when you open it: <link>. If you did not ask for this, ignore this email." (Registered email on POST /v1/keys gets the rotate text.)

Mail seam `src/mail/send.ts`: `interface Mailer { send(msg: {to, from, subject, text}): Promise<void> }`. `getMailer(env, provider): Mailer | null`. `env.MAIL_TRANSPORT === "fake"` returns the fake (set only in vitest.config.ts miniflare bindings; never in wrangler.toml). `provider === "mailchannels"` with `env.MAILCHANNELS_API_KEY` returns the MailChannels adapter: `POST https://api.mailchannels.net/tx/v1/send`, header `X-Api-Key`, JSON personalizations body; throws `MailSendError(status)` on non-2xx. This is the only file that builds a MailChannels URL.
Fake `src/mail/fake.ts`: appends each message to KV `mail:fake:<to>` (JSON array, 1 h TTL), 0 network calls. Exports `readFakeOutbox(kv, to)` for tests. KV, not a module array, so the outbox is visible to the test isolate whatever isolate serves the request.

Confirm route: missing `token` param or a value that is not `tct_<64 hex>`: 400. Token found but `expires_at` past: delete it, 410. Not found: 410. CAS write no row: 410. 410 body `{error: "this link is used or expired; request a new one with POST /v1/keys"}`. 200 body `{key, key_id, plan, email}`, `Cache-Control: no-store`.
The existing `keysRateLimit` (per IP per minute, `keys.anon_rate_per_minute`) stays on `keys.use("*")`, so it covers all three routes.

## Reads and statement count (per request)
- POST /v1/keys and /rotate: one `Promise.all` of settings reads (`keys.max_body_bytes` runs first in the body-limit middleware as today; then `keys.anon_rate_per_minute` in `keysRateLimit` as today; then one parallel group: `keys.confirm_ttl_seconds`, `keys.ip_sends_per_hour`, `keys.email_sends_per_hour`, `mail.daily_send_cap`, `mail.provider`, `mail.from_address`, `keys.confirm_base_url`, plus the 3 KV counter gets). Then 1 D1 SELECT on `api_keys` (idx_api_keys_email, unique). D1 statements: 2 + 7 + 1 = 10. KV: 1 get + 1 put (minute limiter), 3 gets, 1 put token, 3 puts counters.
- GET /v1/keys/confirm: 1 settings read (minute limiter), KV get + delete, 1 D1 write (INSERT on unique idx_api_keys_email, or UPDATE via idx_api_keys_email). D1 statements: 2.
- No screen, no loader, no skeleton: this is a JSON API. No new table.

## Changed symbols
- route `POST /v1/keys`: answers 202 with a fixed body and sends a confirm link; no key, no 409. callers: left alone: no product caller in src; docs updated.
- route `POST /v1/keys/rotate`: new.
- route `GET /v1/keys/confirm`: new.
- function `getMailer` (src/mail/send.ts): new mail seam.
- function `readFakeOutbox` (src/mail/fake.ts): new, test fake.
- function `getSettingText` (src/lib/settings-text.ts): new; reads one text settings row with a fallback.
- function `newKey` (tests/routes/keys-helpers.tcs-8.ts): goes POST, fake outbox, confirm; same return shape `{key, key_id, email}`.
- format `keyconfirm:v1:<hash>` KV value: new.
- format settings rows `keys.confirm_ttl_seconds`, `keys.ip_sends_per_hour`, `keys.email_sends_per_hour`, `mail.daily_send_cap`, `mail.provider`, `mail.from_address`, `keys.confirm_base_url`: new.

## Design collisions
- `getSettingInt` / `src/lib/settings.ts`: open PR #68 adds `getSettingIntList` there. combine — this plan adds `getSettingText` in a NEW file `src/lib/settings-text.ts` and does not edit settings.ts.
- `runCron` / `src/cron/run.ts`: open PR #68 changes it. combine — this plan does not touch it; the daily-cap alert is written on the request path (see ASSUMPTIONS).
- route `POST /v1/keys`: open PR #67 mounts `authIpRateLimit` in `src/app.ts` in front of `/v1/keys`. combine — that gate runs before this router; this plan does not edit app.ts or ratelimit.ts, and the new `/rotate` and `/confirm` sit under the same mount, so #67's gate covers them too.
- migration numbers: #67 and #68 add `0018_*` (and #68 `0017_deliveries.sql`). combine — this plan uses `0019_key_confirm.sql`; the migrations pin test gets this one name added, and whichever PR merges second rebases that list.

## Files to touch
- `migrations/0019_key_confirm.sql` (new): 7 settings rows with `INSERT OR IGNORE`, comment per row.
- `src/lib/settings-text.ts` (new): `getSettingText(db, key, fallback)`.
- `src/mail/send.ts` (new): seam, MailChannels adapter, `MailSendError`, `getMailer`.
- `src/mail/fake.ts` (new): KV-backed fake + `readFakeOutbox`.
- `src/routes/keys.ts`: POST rewrite, `/rotate`, `/confirm`, shared `sendConfirmLink`.
- `src/env.ts`: `MAILCHANNELS_API_KEY?: string`, `MAIL_TRANSPORT?: string` with comments.
- `vitest.config.ts`: `MAIL_TRANSPORT: "fake"` in the api project miniflare bindings; new node project `contract` for `tests/contract/**`, and exclude `tests/contract/**` from the api project.
- `.env.example`: `MAILCHANNELS_API_KEY=` line.
- `.github/workflows/mail-contract.yml` (new): nightly + on push to main + on PRs that change `src/mail/**`; runs `npx vitest run --project contract` with secret `MAILCHANNELS_API_KEY`; 1 worker.
- `docs/API.md`: endpoints table rows, the "Get a key" step, the rate limit list.
- `site/docs.generated.ts`: regenerated by `npm run gen:docs`, never hand-edited.
- `docs/RETENTION.md`: KV `keyconfirm:v1:`, `rl:v1:keyssend:`, `mail:sent:`, `mail:fake:` keys (all TTL, no delete job); settings row count 13 -> 20.
- `tests/routes/keys-confirm.tcs-64.test.ts` (new).
- `tests/routes/keys-budget.tcs-64.test.ts` (new).
- `tests/routes/keys-plan.tcs-64.test.ts` (new): EXPLAIN QUERY PLAN of the 3 api_keys statements.
- `tests/contract/mail.contract.tcs-64.test.ts` (new).
- `tests/routes/keys-helpers.tcs-8.ts` (changed, see below).
- `tests/routes/keys.tcs-8.test.ts` (changed, see below).
- `tests/worker/migrations.tcs-1.test.ts` (changed, see below).

## Tests that must change
- `tests/routes/keys.tcs-8.test.ts`: the premise "POST /v1/keys answers 201 with the key, and a second call answers 409" is reversed by this ticket ("answers 202 with the same body as a first request", "no 409"). The 201/sha256 case moves to the confirm flow; the 409 case becomes "second call 202, identical body"; the rate-limit case expects `[202, 202, 429]`; the 400 cases stay as they are.
- `tests/routes/keys-helpers.tcs-8.ts`: the premise "`newKey` gets the key from the POST answer" changes; `newKey` now POSTs, reads the fake outbox, opens the confirm link. Return shape unchanged, so the watchlists tests stay untouched.
- `tests/worker/migrations.tcs-1.test.ts`: pins the exact migration list; add `0019_key_confirm.sql` to the list and the test name.

## Tasks

T1. Migration `0019_key_confirm.sql`: rows `keys.confirm_ttl_seconds`=3600, `keys.ip_sends_per_hour`=10, `keys.email_sends_per_hour`=3, `mail.daily_send_cap`=500, `mail.provider`='mailchannels', `mail.from_address`='keys@tocsin.sh', `keys.confirm_base_url`='https://tocsin.sh'. `INSERT OR IGNORE` only. Add `getSettingText` in `src/lib/settings-text.ts` (missing row, blank value or failed read returns the fallback and logs the read error, same contract as `getSettingInt`). Each code fallback constant has a comment that names its row.
VALIDATE: npm run migrate:local && npx vitest run --project api tests/worker/migrations.tcs-1.test.ts tests/routes/keys-confirm.tcs-64.test.ts -t "settings rows"
SATISFIES: "Rate limits per IP and per email on the send (settings rows), and a daily cap on sends (a settings row)"; "Mail provider is a DB row (settings.mail.provider) ... the sender address is a settings row."

T2. Mail seam `src/mail/send.ts` + fake `src/mail/fake.ts`; `env.ts` fields; `vitest.config.ts` binding `MAIL_TRANSPORT: "fake"`; `.env.example`.
VALIDATE: npx vitest run --project api tests/routes/keys-budget.tcs-64.test.ts
SATISFIES: "the send goes through one mail seam, src/mail/send.ts, with a fake in tests: 0 network calls in the PR suite"; "Cloudflare Email Routing / MailChannels as the first adapter".

T3. `POST /v1/keys` rewrite and `POST /v1/keys/rotate` through `sendConfirmLink` (Design steps 1-8).
VALIDATE: npx vitest run --project api tests/routes/keys-confirm.tcs-64.test.ts -t "POST"
SATISFIES: "Key creation sends a one-time link to the email"; "A second request for an already registered email re-sends the link to that email and answers 202 with the same body as a first request (no enumeration)"; "Rate limits per IP and per email on the send ... daily cap ... with an alert line".

T4. `GET /v1/keys/confirm` with KV get/delete and the D1 compare-and-swap write.
VALIDATE: npx vitest run --project api tests/routes/keys-confirm.tcs-64.test.ts -t "confirm"
SATISFIES: "the key is shown only after the link is opened (GET /v1/keys/confirm?token=...), token single-use, 1 hour TTL in KV".

T5. Rotate end to end: rotate link replaces `key_hash` in place; old key 401, new key 200, watch lists kept.
VALIDATE: npx vitest run --project api tests/routes/keys-confirm.tcs-64.test.ts -t "rotate"
SATISFIES: "A key can be revoked and re-issued from a confirmed email (POST /v1/keys/rotate with a confirm link)"; "rotate revokes the old hash".

T6. Update `keys-helpers.tcs-8.ts` (`newKey`), `keys.tcs-8.test.ts` and `migrations.tcs-1.test.ts` per "Tests that must change".
VALIDATE: npx vitest run --project api tests/routes tests/worker
SATISFIES: "answers 202 with the same body as a first request (no enumeration)" (the old 409 assertion is removed because the ticket removes the 409).

T7. EXPLAIN QUERY PLAN test for the 3 `api_keys` statements on seeded data (5,000 keys).
VALIDATE: npx vitest run --project api tests/routes/keys-plan.tcs-64.test.ts
SATISFIES: CLAUDE.md iron rule 2 (index proof for every query); ticket item 1 (the lookup and write the confirm flow runs).

T8. Contract suite `tests/contract/mail.contract.tcs-64.test.ts` (node project `contract`): with `MAILCHANNELS_API_KEY` set it calls the real adapter with MailChannels `?dry-run=true` (no mail leaves, no spend); 3 tests: accepted payload answers 2xx, a bad key answers a `MailSendError` with 401, an invalid recipient answers a `MailSendError`. Without the key every test is skipped with the reason "MAILCHANNELS_API_KEY not set". A 5xx or network error from the vendor is `ctx.skip("vendor failure: ...")` plus a `console.error` alert line, never a code failure. Workflow `.github/workflows/mail-contract.yml` runs it with 1 worker.
VALIDATE: npx vitest run --project contract (shows 3 skipped with no key on this box)
SATISFIES: "Mail provider is a DB row ... with Cloudflare Email Routing / MailChannels as the first adapter" (the adapter is checked against the real vendor off the PR path).

T9. Docs: `docs/API.md` (endpoint rows for the 3 routes; step 1 of "API keys and watch lists" rewritten: POST gives 202 and a link, open the link within 60 minutes to get the key, a registered email gets a replace link, rotate; rate-limit bullets for the new rows; 503/502/410 answers), `npm run gen:docs` for `site/docs.generated.ts`, `docs/RETENTION.md`.
VALIDATE: npm run gen:docs && grep -c "v1/keys/confirm" docs/API.md site/docs.generated.ts (each count >= 1) && ! grep -n "answers 409 with no key" docs/API.md
SATISFIES: "the key is shown only after the link is opened" (the public docs must not say the POST answers a key, D5).

## Verify (run, not edited)
- npm test
- npm run typecheck
- npm run migrate:local
- npm run gen:docs (then `git diff` shows only the expected docs change)

## ASSUMPTIONS
- "Cloudflare Email Routing / MailChannels": Cloudflare Email Routing `send_email` sends only to verified destination addresses, so it cannot mail arbitrary users. Assumed: the MailChannels Email API (`api.mailchannels.net/tx/v1/send`, `X-Api-Key`) is the first adapter. Other reading: Cloudflare Email Service binding; that would be a second adapter behind the same `mail.provider` row.
- What the link does for an email that already has a key (the ticket says only "re-sends the link"): the plaintext key is not stored, so it cannot be shown again. Assumed: the link replaces the key (rotate in place, same key_id and lists). That is the victim's recovery path from the ticket's "Why". Other reading: the link only says "a key exists"; that leaves no recovery path, so it was rejected.
- Per-email and per-IP send limits answer 429, not 202. A 429 says only "this email was asked for in the last hour", which is true for new and registered emails alike, so it does not enumerate. Other reading: silent 202 with no send; rejected because a real user would wait for a mail that never comes.
- Daily cap and "not configured" answer 503; a provider failure answers 502. None depends on the email.
- "an alert line in the cron log when hit": the cap is hit on the request path. Assumed: one `console.error` JSON line `{lane:"mail", alert:"daily_send_cap_hit"}` in the worker log, which is the same Workers log stream the cron lanes write. Other reading: a cron step that reads the counter; not done because `src/cron/run.ts` is changed by open PR #68, and the request-path line fires at the moment of the hit.
- Per-IP limit: the ticket asks for a per-IP send limit as a settings row. The existing per-minute row covers bursts; assumed a new per-hour row `keys.ip_sends_per_hour`=10 as well. Seed values 3 per email per hour, 10 per IP per hour, 500 per day are my picks; they are rows, so an operator changes them without a deploy.
- Keys issued under TCS-8 with no email proof stay valid. Assumed: no revoke of existing rows (data-loss risk). The real owner can take the key back with rotate. Other reading: a migration that revokes all unconfirmed keys; rejected as destructive.
- Link scanners in some mail systems open GET links. The ticket fixes `GET /v1/keys/confirm`, so this plan keeps GET. A scanner that opens the link would see the key and burn the token; the user then asks again. Other reading: GET shows a page with a POST button. Left for a follow-up if it happens.
- The fake is chosen by an env binding `MAIL_TRANSPORT=fake` set only in `vitest.config.ts`. If it were ever set in prod, mail would stop, but no token or key would leak (the fake never echoes the token in a response).

## Failure modes
This plan changes no path under bin/ or worker/. Section kept short.
- Decision rule: n/a — no classifier; the email-exists branch only picks the mail text and the CAS kind. Test: acceptance 3 and 5.
- Exit paths: 400/429/503/502 write no token and no counter (503-not-configured, 429, 400) or delete the token (502). Test: acceptance 9, 10, 11.
- Writer/reader round-trip: `keyconfirm:v1:` value is written by `sendConfirmLink` and read by confirm. Test: acceptance 2 and 4.
- Alert or freeze blast radius: at most one `console.error` alert line per refused request (`daily_send_cap_hit` or `mail_not_configured`); no page, no freeze, no other route stops. Test: acceptance 9 (daily cap: 503, one `daily_send_cap_hit` line, no fake send) and acceptance 10 (not configured: 503, one `mail_not_configured` line, no token).
- Defaults in prod: rows as in T1. `mail.provider`='mailchannels' with no `MAILCHANNELS_API_KEY` secret gives 503 on key sign-up until an operator sets the secret; it never falls back to the fake. Test: acceptance 13 (the 7 rows exist with the seed values), keys-budget case 3 (`MAIL_TRANSPORT` unset and no `MAILCHANNELS_API_KEY`: `getMailer` returns null) and acceptance 10 (no mailer: 503).
- Status evidence: 202 is sent only after the provider answered 2xx; a failed send answers 502 and leaves the counters unchanged. Test: acceptance 1 (202 with exactly 1 fake send) and acceptance 11 (fake throws `MailSendError(500)`: 502, the next POST still sends).

## Operator steps (go-live, PR body)
1. `wrangler secret put MAILCHANNELS_API_KEY`.
2. DNS on tocsin.sh: the MailChannels Domain Lockdown TXT record `_mailchannels` and SPF/DKIM for `keys@tocsin.sh`.
3. Actions secret `MAILCHANNELS_API_KEY` for the contract workflow.
4. Apply `0019_key_confirm.sql` to the prod D1 through the normal deploy path.
Until step 1, `POST /v1/keys` answers 503 in prod.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section
TEST-CHANGE: <- Tests that must change
MAILCHANNELS_API_KEY <- Operator steps 1 and 3 (new env var in every environment)
```

## System invariants
(a) Cross-run state. Token: KV `keyconfirm:v1:<sha256(token)>` with TTL; the durable single-use guard is the D1 compare-and-swap on `api_keys` (unique `idx_api_keys_email` + `key_hash` match), not KV. Counters: KV with TTL, approximate under bursts across locations (same accepted trade as `rl:` keys). No new table.
(b) Side effects. Mail send: token written before send; 2xx -> counters incremented, 202; non-2xx or throw -> token deleted, counters unchanged, 502; not configured -> nothing written, 503. A key is never created at send time, only on confirm. Confirm: token deleted before the D1 write; D1 write fails -> 500 and the user asks for a new link (no half state: the write is one statement).
(c) Adversarial negatives for the enumeration guard: a registered email, a registered email in upper case with spaces, an email whose key was just rotated, and a never-seen email all get a byte-identical 202 body and the same headers apart from date. Per-email 429 is identical for registered and new. Tests 3 and 7 assert these.
(d) Neighbors. `keysRateLimit` (per minute) stays first on the router; open PR #67 adds a per-IP gate in app.ts before it. The monthly key retention cron deletes by `last_used_at`; rotate sets `last_used_at`=now, so a rotated key restarts its 365 days. `requireApiKey` reads by `key_hash`; after a rotate the old hash has no row, so the old key is 401 at once. No cron lane, lock or queue is added.

## Requirements coverage
| Requirement | Task | Test |
|---|---|---|
| Creation sends a one-time link via `src/mail/send.ts` | T2, T3 | keys-confirm 1 |
| Fake in tests, 0 network calls in the PR suite | T2 | keys-budget |
| Key shown only after the link is opened | T3, T4 | keys-confirm 1, 2 |
| Token single-use | T4 | keys-confirm 2, 6 |
| Token 1 hour TTL in KV | T1, T4 | keys-confirm 4 |
| Second request: re-send, 202, same body | T3 | keys-confirm 3 |
| NEGATIVE: no 409, no enumeration | T3, T6 | keys-confirm 3, 7; keys.tcs-8 409 case replaced |
| NEGATIVE: POST no longer answers a key | T3, T6 | keys-confirm 1 (no `key` field, 0 rows) |
| Revoke and re-issue via `POST /v1/keys/rotate` + link | T5 | keys-confirm 5 |
| Rotate revokes the old hash | T5 | keys-confirm 5 (old key 401) |
| Rate limit per IP on the send (settings row) | T1, T3 | keys-confirm 8; keys.tcs-8 rate case |
| Rate limit per email on the send (settings row) | T1, T3 | keys-confirm 7 |
| Daily send cap (settings row) + alert line | T1, T3 | keys-confirm 9 |
| Provider is a DB row `mail.provider` | T1, T2 | keys-confirm 10 |
| Sender address is a settings row | T1, T3 | keys-confirm 11 (from row reaches the fake) |
| MailChannels as the first adapter | T2, T8 | contract suite |
| Out of scope: OAuth, dashboard | none | none |

## Acceptance tests
`tests/routes/keys-confirm.tcs-64.test.ts` (through `exports.default.fetch`, the production entry; unique emails and IPs per test; outbox read with `readFakeOutbox`):
1. First request: 202, body `{"status":"sent","expires_in_seconds":3600}`, `Cache-Control: no-store`, no `key` field, 0 `api_keys` rows for the email, exactly 1 fake send to the email whose text holds `https://tocsin.sh/v1/keys/confirm?token=tct_`.
2. Confirm link: 200 with `key` matching `/^tcs_[0-9a-f]{64}$/`, `plan` "free", `email`; the row's `key_hash` is sha256(key); no column holds the plaintext. The same link again: 410, no key.
3. Second request for the same email after the key exists (also upper-case with spaces): 202 and the body is byte-identical to the body for a never-seen email; a second fake send arrives; no 409. The second mail has the replace text.
4. Expiry: pin the clock, POST, move the clock +3601 s, confirm: 410 and no row. Move +3599 s on a second token: 200.
5. Rotate: get K1 through the flow, create one watch list with K1, `POST /v1/keys/rotate`: 202 identical body, one send; confirm: 200 with K2 != K1, same `key_id`; `GET /v1/watchlists` with K1: 401; with K2: 200 and the list is still there.
6. Single use under a race: two links sent before either is opened (new email): open both; one 200, one 410; exactly 1 row.
7. Per-email limit: set `keys.email_sends_per_hour`=2; 3 POSTs for one email from 3 IPs: `[202, 202, 429]` with `Retry-After`; a registered email and a new email get the same 429 body.
8. Per-IP hour limit: set `keys.ip_sends_per_hour`=2; 3 POSTs, 3 emails, one IP: `[202, 202, 429]`.
9. Daily cap: set `mail.daily_send_cap`=1; second send: 503, no fake send, and `console.error` was called with a line holding `"alert":"daily_send_cap_hit"` (vi.spyOn).
10. Not configured: set `mail.provider`='nope': 503, no token written (no fake send), alert line `mail_not_configured`.
11. Send failure: set `mail.from_address`='fail@fake.test' (the fake throws `MailSendError(500)` for that sender): 502, the counters stay unchanged (a following POST still sends).
12. Bad input: `{}`, `{"email":"a@b"}`, non-JSON: 400 on both POST routes. `GET /v1/keys/confirm` with no token or `token=abc`: 400.
13. Settings rows: the 7 rows exist with the seed values.

`tests/routes/keys-budget.tcs-64.test.ts`:
- `vi.spyOn(globalThis, "fetch")` across a full create + confirm + rotate + confirm flow: 0 calls whose URL host is `api.mailchannels.net` (0 calls at all from the mail path).
- `getMailer(env, "mailchannels")` in the test env returns the fake (not the MailChannels adapter).
- With `MAIL_TRANSPORT` unset and no `MAILCHANNELS_API_KEY`, `getMailer` returns null (fail closed, not a silent fake).

`tests/routes/keys-plan.tcs-64.test.ts`: seed 5,000 `api_keys` rows; `EXPLAIN QUERY PLAN` of `SELECT key_hash FROM api_keys WHERE email = ?`, the CAS `UPDATE ... WHERE email = ? AND key_hash = ?`, and the INSERT conflict target each name `idx_api_keys_email` and no plan row is `SCAN api_keys`.

`tests/contract/mail.contract.tcs-64.test.ts`: T8.

Changed: `tests/routes/keys.tcs-8.test.ts`, `tests/routes/keys-helpers.tcs-8.ts`, `tests/worker/migrations.tcs-1.test.ts` (see "Tests that must change").

Regression risk: `tests/routes/watchlists.tcs-8.test.ts`, `watchlists-limits.tcs-8.test.ts`, `watchlists-tenant.tcs-8.test.ts`, `watchlists-plan.tcs-8.test.ts` (all call `newKey`; each key now costs 2 calls and 1 fake send; unique email and IP per call, so the per-email and per-IP hour limits never trip; the daily cap of 500 is per test file storage and no file makes more than ~40 keys), `tests/routes/ratelimit.tcs-3.test.ts` (other scopes), `tests/cron/retention.tcs-8.test.ts` (seeds rows directly), `tests/launch/*` (does not call /v1/keys; grep shows no use), `tests/mcp/tools.test.ts` (the "keys" match is a path-traversal string, not this route).

## QA screens
No browser screen. API flow for a QA pass on a preview with a MailChannels key: `POST /v1/keys {"email": <a real inbox>}` -> 202; open the mailed link -> JSON with the key; `GET /v1/watchlists` with the key -> 200; `POST /v1/keys/rotate` -> open the link -> old key 401. The docs page `/docs` shows the new step 1 text.

## Design collision check (BH-5791)

Checked 9 listed and 0 derived symbols against main 41c4549a09d1..41c4549a09d1 and 2 open PRs.
- `POST /v1/keys` (function, listed): PR #68 dca953f2a735, (text match). Resolution: combine.
- `POST /v1/keys` (function, listed): PR #67 4de7fd755f69, (text match). Resolution: combine.

## Size
FILES: 9
LINES: 380
DIFF_KB: 60

KIND: feature
SIZE: M
