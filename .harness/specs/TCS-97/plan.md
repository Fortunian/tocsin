# TCS-97 plan: Mail: Resend adapter as the provider (no MailChannels account)

Ticket: https://github.com/Fortunian/tocsin/issues/97 (label ai-build, open). Blocked-by #83: CLOSED. #94: CLOSED (merged as e55f304).
Already on main? No. `git log origin/main --since=2026-10-24T18:34:36Z` shows no commit; `git log origin/main -S resend -i` finds nothing in src/. No PR or branch for TCS-97 exists.
CodeGraph: NOT AVAILABLE on this box. File set comes from grep over `getMailer`, `resolveDkim`, `mail.provider`, `Tocsin-Mail-Dkim`, `MAILCHANNELS_API_KEY`.

## Spec changes from comments
- 6388084766 (liorwn, 2026-10-24T18:43Z): operator state is done. tocsin.sh is on the CTOx Resend team (us-east-1, return-path `send`). Live DNS: TXT `resend._domainkey.tocsin.sh`, CNAME `send.tocsin.sh` and `rsend.tocsin.sh`, root SPF `v=spf1 -all`, DMARC `p=quarantine; adkim=s; aspf=r`. The MailChannels SPF include and the `mcdkim` record are removed. `DKIM_PRIVATE_KEY` on the worker is unused. The one open step is the secret `RESEND_API_KEY` (sending-only key, restricted to tocsin.sh). Effect on scope: T5 documents these records as the current state (not as steps to do) and removes the MailChannels lockdown/SPF/mcdkim steps from the live procedure; the only operator steps left are "wait for Resend verification", "set RESEND_API_KEY", "set the Actions secret", "run the launch check".

## Scope
Add a Resend adapter to the one mail seam (`src/mail/send.ts` `getMailer`), select it by the settings row `mail.provider = resend`, flip the seeded row to `resend` by migration, never send DKIM fields to Resend (Resend signs), keep MailChannels as the other adapter, add a Resend contract suite off the PR path, and update OPERATING.md.

## Files to touch
- `src/mail/resend.ts` (new): `ResendMailer` class.
- `src/mail/send.ts`: `PROVIDERS` gains `resend`; `getMailer` env Pick gains `RESEND_API_KEY`; new export `providerSignsDkim(provider)`; header comment ("only file that builds a MailChannels URL" becomes "send.ts and resend.ts are the only files that build a vendor URL").
- `src/routes/keys.ts`: `sendConfirmLink` skips `resolveDkim` and the unsigned warning when the provider signs; header value `provider`; `FALLBACK_MAIL_PROVIDER = "resend"`.
- `src/env.ts`: `RESEND_API_KEY?: string` with comment.
- `.env.example`: `RESEND_API_KEY=` with comment; MailChannels line says "only when mail.provider = mailchannels"; DKIM line says "MailChannels only; unused with Resend".
- `migrations/0031_mail_resend.sql` (new): `UPDATE settings SET value = 'resend' WHERE key = 'mail.provider' AND value = 'mailchannels';` Data only, no schema change.
- `scripts/launch-check.sh`: one new `case` arm `provider) ok "keys-signup (dkim signed by the provider)" ;;` and the header comment line for it.
- `.github/workflows/mail-contract.yml`: `RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}` env; `paths` adds `tests/contract/mail-resend.contract.tcs-97.test.ts`; comment says each suite skips without its key.
- `docs/OPERATING.md`: mail section rewritten for Resend (see T5).
- `tests/mail/resend.tcs-97.test.ts` (new)
- `tests/routes/keys-resend.tcs-97.test.ts` (new)
- `tests/launch/launch-resend.tcs-97.test.ts` (new)
- `tests/contract/mail-resend.contract.tcs-97.test.ts` (new)
- `tests/routes/keys-dkim.tcs-94.test.ts` (TEST-CHANGE, see below)
- `tests/launch/launch-dkim.tcs-94.test.ts` (TEST-CHANGE, see below)

## Tests that must change
- `tests/routes/keys-dkim.tcs-94.test.ts`: R1 to R3 assume the seeded `mail.provider` is `mailchannels`; migration 0031 seeds `resend`. The change: set `mail.provider = 'mailchannels'` in a `beforeEach` of the file (and restore in `afterAll`). No assertion changes.
- `tests/launch/launch-dkim.tcs-94.test.ts`: L1 to L3 assume the seeded `mail.provider` is `mailchannels`. The change: one `UPDATE settings SET value = 'mailchannels' WHERE key = 'mail.provider'` after each `startLocalWorker`. No assertion changes.

```pr-body-requires
TEST-CHANGE: `tests/routes/keys-dkim.tcs-94.test.ts` <- Tests that must change
TEST-CHANGE: `tests/launch/launch-dkim.tcs-94.test.ts` <- Tests that must change
RESEND_API_KEY <- T2 (new env var: wrangler secret on the main worker + Actions secret for mail-contract.yml)
## ASSUMPTIONS <- plan ASSUMPTIONS section
```

## Verify (run, not edited)
- `npm test`, `npm run typecheck`, `npm run migrate:local`
- `tests/routes/keys-budget.tcs-64.test.ts` (0 vendor calls in the PR suite; unchanged, must stay green)
- `tests/routes/keys-confirm.tcs-64.test.ts`, `tests/routes/keys-caps.tcs-83.test.ts`, `tests/launch/launch-keys.tcs-83.test.ts`, `tests/unit/mail-dkim.tcs-94.test.ts`, `tests/contract/mail.contract.tcs-64.test.ts`

## Sibling claims (not touched)
`/root/harness/state/claims/tocsin/` is empty at plan time. No overlap.

## Tasks

### T1. Resend adapter `src/mail/resend.ts`
`export class ResendMailer implements Mailer { constructor(private readonly apiKey: string) {} }`. `send(msg)`: `fetch("https://api.resend.com/emails", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text }) })`. Non-2xx: read the body text once, try `JSON.parse(..).message` (string), else the raw text; slice to 200; throw `new MailSendError(res.status, detail)`. The key never goes into the error or a log. No dkim parameter at all (Resend signs). No dry run: Resend has none, so the fake covers the PR suite (ticket scope 1, else-branch). The URL is a vendor protocol constant, not a knob (same as `MAILCHANNELS_SEND_URL`).
VALIDATE: npm test -- tests/mail/resend.tcs-97.test.ts
SATISFIES: Scope 1 "POST https://api.resend.com/emails with Authorization: Bearer $RESEND_API_KEY ... a non-2xx is a MailSendError with the status and the body's message"; AT "the adapter sends the documented JSON shape with the bearer header to a fake fetch; a 422 becomes a MailSendError with the message".

### T2. Provider selection in the seam + env
`src/mail/send.ts`: `PROVIDERS = new Set(["mailchannels", "resend"])`. `getMailer(env: Pick<Env, "CURSORS" | "MAIL_TRANSPORT" | "MAILCHANNELS_API_KEY" | "RESEND_API_KEY">, provider, dkim)`: unknown provider → null; `MAIL_TRANSPORT=fake` → `new FakeMailer(env.CURSORS, providerSignsDkim(provider) ? null : dkim)`; `resend` with `RESEND_API_KEY` → `new ResendMailer(key)` (dkim ignored); `mailchannels` with key → unchanged; else null. New `export function providerSignsDkim(provider: string): boolean` (true only for `resend`; a `Set` named `PROVIDER_SIGNS`). `src/env.ts` and `.env.example` get `RESEND_API_KEY` with the 503-when-unset comment.
VALIDATE: npm test -- tests/mail/resend.tcs-97.test.ts tests/routes/keys-budget.tcs-64.test.ts && npm run typecheck
SATISFIES: Scope 2 "Provider selection by the settings row (mail.provider = resend), the secret name RESEND_API_KEY in src/env.ts and .env.example; MailChannels stays as the other adapter"; AT "with mail.provider=resend the seam picks the Resend adapter; with mailchannels the old one".

### T3. Route: no DKIM fields and no false unsigned warning for Resend; seed flip
`src/routes/keys.ts` `sendConfirmLink`: `const providerSigns = providerSignsDkim(provider); const dkim = providerSigns ? null : resolveDkim(...)`; `getMailer(c.env, provider, dkim?.state === "signed" ? dkim.config : null)`; after a sent mail, `if (dkim && dkim.state !== "signed") noteDkimUnsigned(...)`; header `Tocsin-Mail-Dkim: dkim ? dkim.state : "provider"`. The two DKIM settings reads stay in the one `Promise.all` (no new statement, no sequential await). `FALLBACK_MAIL_PROVIDER = "resend"` (comment names the row). `migrations/0031_mail_resend.sql`: the guarded UPDATE above, with a comment (TCS-97, data only; an operator-edited value other than `mailchannels` is kept). This puts the knob change in the apply mechanism, not in a hand step (CLAUDE.md "Schema and knobs never ride a deploy as a hand step"). Until `RESEND_API_KEY` is set, POST /v1/keys answers 503 as it does today (no MailChannels key in prod).
VALIDATE: npm test -- tests/routes/keys-resend.tcs-97.test.ts tests/routes/keys-dkim.tcs-94.test.ts && npm run migrate:local
SATISFIES: Scope 3 "the seam must NOT send dkim fields for Resend (Resend signs)"; Why "the provider becomes Resend".

### T4. Launch check accepts the provider-signed header
`scripts/launch-check.sh`: new arm `provider) ok "keys-signup (dkim signed by the provider)" ;;` plus the header comment. The 202/503 logic and the check count do not change.
VALIDATE: npm test -- tests/launch/launch-resend.tcs-97.test.ts tests/launch/launch-keys.tcs-83.test.ts tests/launch/launch-dkim.tcs-94.test.ts
SATISFIES: Scope 5 "Launch check keys-signup unchanged (202 when configured)".

### T5. Contract suite + workflow + docs
`tests/contract/mail-resend.contract.tcs-97.test.ts` (`// contract-test` header): `CONTRACT_ENABLED = process.env.TOCSIN_CONTRACT === "1"`, `describe.skipIf(!CONTRACT_ENABLED)`, each test skips with "RESEND_API_KEY not set" when the key is absent, a 5xx or network error is `vendorFailure` (skip plus an alert line), same shape as the tcs-64 suite. Three tests: (1) a bad key (`key-fixture-invalid`) answers a MailSendError with status 401 or 403 (no send, no spend); (2) an invalid recipient `not-an-address` answers a MailSendError 4xx (no send); (3) a well-formed message from `MAIL_CONTRACT_FROM` (default `keys@tocsin.sh`) to Resend's test address `delivered@resend.dev` is accepted (2xx). Test 3 is one real send per run and counts against the 3,000/month quota (about 30 to 60 per month at nightly + main); this is written in the file header and OPERATING.md. `mail-contract.yml`: add the env line and the path. `docs/OPERATING.md`: the mail section names Resend as the provider; lists the live DNS records from comment 6388084766 as current state; steps: (1) confirm the domain shows Verified in Resend; (2) `wrangler secret put RESEND_API_KEY` (sending-only key restricted to tocsin.sh); (3) set the Actions secret `RESEND_API_KEY` for mail-contract.yml; (4) settings table: `mail.provider` seed `resend` (`mailchannels` is the other value), `mail.dkim_domain`/`mail.dkim_selector` and `DKIM_PRIVATE_KEY` used only when `mail.provider = mailchannels`; (5) launch check line `ok keys-signup (dkim signed by the provider)`, and to confirm the signature read the received mail (`d=tocsin.sh; s=resend`, `dkim=pass`). The MailChannels lockdown/SPF/DKIM procedure moves to a short "Switching back to MailChannels" subsection.
VALIDATE: TOCSIN_CONTRACT=1 npx vitest run --project contract (without RESEND_API_KEY every Resend test reports skipped, exit 0) && grep -n "RESEND_API_KEY" .github/workflows/mail-contract.yml docs/OPERATING.md .env.example src/env.ts
SATISFIES: Scope 4 "The contract suite gains a Resend variant behind TOCSIN_CONTRACT=1 and RESEND_API_KEY (off the PR path); mail-contract.yml runs whichever key exists"; Scope 3 "Update docs/OPERATING.md ... The mcdkim record and DKIM_PRIVATE_KEY stay unused (document)".

## Changed symbols
- function `getMailer`: accepts provider `resend` and the env key `RESEND_API_KEY`; passes no dkim to the fake for a provider that signs. callers: `src/routes/keys.ts` sendConfirmLink (updated in T3); tests keys-budget.tcs-64 left alone: their calls (`mailchannels`, `nope`) keep the same answers.
- function `providerSignsDkim` (new): true only for `resend`.
- function `ResendMailer.send` (new class in `src/mail/resend.ts`).
- function `sendConfirmLink`: no DKIM resolve, no unsigned warning, header `provider` when the provider signs.
- format `Tocsin-Mail-Dkim` response header: new value `provider` (old values `signed`, `off`, `incomplete` unchanged).
- format settings row `mail.provider`: seed value becomes `resend` (migration 0031); `FALLBACK_MAIL_PROVIDER` becomes `resend`.
- verb `scripts/launch-check.sh keys-signup`: accepts `provider` as ok.

## ASSUMPTIONS
- The ticket says "subject and text/html body". `MailMessage` has only `text`, and the one caller sends plain text. Assumed: send `text` only, no `html`. Other reading: add an optional `html` field to `MailMessage` and both adapters.
- Flip the seeded row by migration 0031 (guarded `WHERE value = 'mailchannels'`) instead of an operator UPDATE. Reason: the ticket says the provider becomes Resend, and the fleet rule forbids a knob change as a hand step. Reverse: `UPDATE settings SET value = 'mailchannels' WHERE key = 'mail.provider'`. Other reading: leave the seed and add an operator step.
- New header value `provider` (plus one launch-check case arm) instead of reusing `signed` or `off`. Reason: `off` makes the launch check print "unsigned" and writes a false unsigned warning; `signed` claims the request carried our DKIM fields, which is false for Resend and unproven while verification is pending. "Launch check unchanged" is read as "the 202 check and its count do not change". Other reading: emit `signed` and leave the script untouched.
- #94 is already merged and closed. The DKIM code, the `mail.dkim_*` rows and `DKIM_PRIVATE_KEY` stay, because the MailChannels adapter still uses them and the schema is additive-only. They are documented as unused with Resend. Other reading: delete them in this PR (refused: removes a working adapter path).
- No `Idempotency-Key` header on the Resend call. Dedup before spend is already the D1 reserve in `reserveSend` before the send. Other reading: pass the token hash as Resend's idempotency key.
- Contract test 3 sends one real mail to `delivered@resend.dev` per run. Resend has no dry run. Other reading: keep only the no-spend tests (bad key, bad recipient) and prove a 2xx only by the operator launch check.
- The ticket proposes `tests/mail/resend.tcs-NN.test.ts`; used `tests/mail/resend.tcs-97.test.ts` (the api vitest project includes `tests/**/*.test.ts`).

## Edge cases
- `mail.provider = resend` with no `RESEND_API_KEY`: `getMailer` → null → 503 `mail_not_configured`, no token, no counter (existing path).
- `resend` with `DKIM_PRIVATE_KEY` set: no dkim fields in the request or the fake outbox, header `provider`, no warning write.
- Resend non-2xx with a non-JSON body, an empty body, or JSON without `message`: detail is the raw text (sliced) or empty; still a MailSendError with the status, so the route refunds the caps and answers 502.
- An error body that echoes the key: the adapter never puts the key into the message (it only reads the response); a test asserts the thrown message does not contain the fixture key.
- Operator already changed `mail.provider` to another value: the guarded UPDATE keeps it.

## Entry points
no user-facing entry point (backend mail adapter; the existing `POST /v1/keys` flow is unchanged for the caller).

## Iron laws applied
- Additive-only schema: 0031 is a data UPDATE on an existing row, no DDL. No new table, so no new index, EXPLAIN proof or retention rule; `settings` lookup is by PK.
- DB-driven config: provider stays the `mail.provider` row; the code fallback names the row. No new limit or knob literal.
- Dedup before spend: unchanged; `reserveSend` runs in D1 before the metered send for both providers.
- Scalable tests (BH-7563): one seam per vendor (`resend.ts`, imported only by `send.ts`); fake in test mode; contract suite 1 worker, main + nightly + adapter PRs; 0 vendor calls in the PR suite (R4 + keys-budget).
- No secrets: tests use `key-fixture-*` strings; `.env.example` has an empty value.
- No model id, no LLM, no UI. Sortable headers, list-over-cards, drill-down, RLS: n/a (no UI, D1 not Supabase).
- Performance: route reads stay one `Promise.all` of 9 settings reads; statement count unchanged (one fewer warning write for resend).
- Build discipline rules that bite: D1 (mutation check above), D2 (route tests through `worker.fetch`), D5 (OPERATING.md claims only what code does), D8 (secret steps in PR body), D9 (non-2xx never maps to success), D13 (header/launch-check copy true for resend), D26 (no invented key or URL; DNS names quoted from comment 6388084766).

## System invariants
- (a) Cross-run state: no new store. The send caps stay in `send_counters` (TCS-83), the provider choice is the existing `settings` row.
- (b) Side effect = one Resend HTTP send. Success: 2xx → route answers 202 with header `provider`, writes no warning. Failure: non-2xx or network error → MailSendError/throw → the route deletes the KV token, refunds the three caps and answers 502 (existing order: reserve → token write → send → on failure refund). Not configured: null mailer → 503 before any reserve or token. "Stamped done without delivery" is impossible: the 202 is returned only after `send` resolves, and `send` resolves only on `res.ok`.
- (c) Negatives for `providerSignsDkim`: `mailchannels`, `nope`, `""`, `Resend` (case differs), ` resend` (spaces) must all be false; the route then follows the DKIM path or 503. The row reader (`getSettingText`) returns the stored value; this plan does not add normalization (an unknown value already fails closed with 503). Tests include `mailchannels`, `nope`, `Resend`.
- (d) Neighbors: TCS-83 send caps (unchanged; reserve runs before the send for both providers); TCS-94 DKIM warning row `sources.mail` (not written for resend); TCS-64 budget test (fake in tests, 0 fetch); mail-contract.yml (one concurrency group `mail-contract`, 1 worker, now 2 suites); daily retention job of send_counters (no change). No cron, queue or lock change.

## Requirements coverage
| Requirement (ticket/thread) | Task | Test |
|---|---|---|
| Resend adapter, POST /emails, Bearer header, from, one recipient, subject, body | T1 | tests/mail/resend.tcs-97.test.ts M1 |
| Non-2xx → MailSendError with status and body message | T1 | M2 (422 JSON), M3 (non-JSON body), M4 (no key in message) |
| Dry run if offered, else fake covers tests | T1, T2 | M5 (fake answered for resend under MAIL_TRANSPORT=fake), keys-budget.tcs-64 unchanged |
| Provider selection by `mail.provider = resend` | T2, T3 | M6 (getMailer resend → ResendMailer, mailchannels → MailChannelsMailer, no key → null, `Resend`/`nope` → null), R1 route |
| `RESEND_API_KEY` in src/env.ts and .env.example | T2 | typecheck; T5 grep VALIDATE |
| MailChannels stays as the other adapter | T2 | M6; keys-dkim.tcs-94 R1 to R3 still green with provider mailchannels |
| NEGATIVE: no dkim fields sent for Resend | T2, T3 | R2 (DKIM secret set, provider resend: outbox entry has no dkim_* field), M1 (body keys exactly from/to/subject/text) |
| NEGATIVE: no false "unsigned" warning for Resend | T3 | R3 (sources.mail last_warning unchanged after a resend send) |
| The provider becomes Resend (seed) | T3 | L1 (fresh Miniflare from migrations: `mail.provider` = `resend`) |
| OPERATING.md: domain in Resend, records, key, secret; mcdkim and DKIM_PRIVATE_KEY unused | T5 | T5 grep VALIDATE; review reads the doc |
| Contract suite Resend variant behind TOCSIN_CONTRACT=1 and RESEND_API_KEY, off PR path | T5 | contract file; keys-budget.tcs-64 test 1 (npm test excludes contract) unchanged |
| mail-contract.yml runs whichever key exists | T5 | each suite skips without its key; T5 VALIDATE run without keys exits 0 |
| Launch check keys-signup 202 when configured | T4 | L2 (ok keys-signup (dkim signed by the provider), 6 of 6), launch-keys.tcs-83 K1 unchanged |
| 0 real calls in the PR suite | T2 | R4 (create + confirm with provider resend: fetch spy not called), keys-budget.tcs-64 unchanged |

## Acceptance tests
- `tests/mail/resend.tcs-97.test.ts` (api project, stubbed `fetch` via `vi.spyOn`, no network):
  - M1: `new ResendMailer("key-fixture-1").send(msg)` posts once to `https://api.resend.com/emails`, method POST, `Authorization: Bearer key-fixture-1`, `Content-Type: application/json`, body equals `{ from, to: [to], subject, text }` exactly (no dkim_* key).
  - M2: a 422 answer `{"statusCode":422,"message":"Invalid `to` field.","name":"validation_error"}` throws MailSendError, status 422, message contains `Invalid \`to\` field.`.
  - M3: a 500 with body `oops` throws MailSendError status 500 with `oops` in the message.
  - M4: the thrown message never contains the key, even when the response body is empty.
  - M5: with `MAIL_TRANSPORT=fake`, `getMailer(env, "resend", CFG)` answers FakeMailer, and a send writes an outbox entry with no dkim_* field.
  - M6: with `MAIL_TRANSPORT` unset: `resend` + key → ResendMailer; `resend` no key → null; `mailchannels` + key → MailChannelsMailer; `Resend`, `nope` → null. `providerSignsDkim`: true for `resend`; false for `mailchannels`, `nope`, `Resend`, `""`.
- `tests/routes/keys-resend.tcs-97.test.ts` (api project, worker default export, fake mailer, `mail.provider` set to `resend` in `beforeEach`):
  - R1: POST /v1/keys answers 202 with `Tocsin-Mail-Dkim: provider`; one outbox entry.
  - R2: with `DKIM_PRIVATE_KEY` set in the env override: the outbox entry has no `dkim_domain`, `dkim_selector` or `dkim_private_key`.
  - R3: `sources.mail.last_warning` and `last_run_at` do not change after the send.
  - R4: create + confirm with provider resend makes 0 `fetch` calls.
  - R5: provider `mailchannels` on the same route still answers header `off` (no secret) or `signed` (secret set) — proves the switch both ways through the production entry point.
- `tests/launch/launch-resend.tcs-97.test.ts` (launch project, Miniflare from migrations, fake mailer):
  - L1: the migrated `settings` row `mail.provider` is `resend`.
  - L2: `KEYS_CHECK=1 KEYS_CHECK_EMAIL=<unique>` prints `ok keys-signup (dkim signed by the provider)`, `launch-check: 6 of 6 passed`, exit 0; one outbox entry with no dkim_* field.
- `tests/contract/mail-resend.contract.tcs-97.test.ts` (contract project, off the PR path): the three tests in T5.
- Mutation check (D1): return `null` from `getMailer` for resend (R1 goes 503, red); pass dkim to the fake for resend (R2 red); drop the `provider` case arm (L2 red); drop the migration (L1 red); remove the Bearer header (M1 red).
- Regression risk: `tests/routes/keys-budget.tcs-64.test.ts`, `keys-confirm.tcs-64`, `keys-caps.tcs-83`, `keys-dkim.tcs-94`, `tests/launch/launch-keys.tcs-83`, `launch-dkim.tcs-94`, `tests/unit/mail-dkim.tcs-94`.

## QA screens
- No UI screen changes. API only: `POST https://tocsin.sh/v1/keys` (202 with `Tocsin-Mail-Dkim: provider` once `RESEND_API_KEY` is set, 503 before). Operator flow: `KEYS_CHECK=1 KEYS_CHECK_EMAIL=<inbox> bash scripts/launch-check.sh`.
- Not verified here: a real Resend send (no RESEND_API_KEY on this box, domain verification pending at 2026-10-24 ~20:00Z).

## Design collision check (BH-5791)

Checked 7 listed and 0 derived symbols against main e55f304325f3..e55f304325f3 and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 8
LINES: 110
DIFF_KB: 32

KIND: feature
SIZE: M
