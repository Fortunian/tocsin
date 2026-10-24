# TCS-94 plan: DKIM signing for keys@tocsin.sh (selector, key, DMARC)

Ticket: Fortunian/tocsin#94. Blocked-by #83: CLOSED (merged as 11586de, PR #86).
Already on main? No. `git log origin/main --since=2026-10-24T16:12:44Z` shows only 1197961 (dns workflow, no mail code). `git log origin/main -Sdkim` finds only 11586de, which added the "Open gap" doc text this ticket closes. `src/mail/send.ts` on main sends no `dkim_*` field.

CodeGraph: NOT AVAILABLE on this box. Files and callers come from grep (evidence cited under "Regression risk").
Sibling claims: `/root/harness/state/claims/tocsin/` is empty. No overlap.
Open PRs on Fortunian/tocsin: none. No design collision.

## Spec changes from comments
- 6386594853, liorwn (2026-10-24T16:22Z): the secret `DKIM_PRIVATE_KEY` is already set on the worker; selector is `mcdkim`; the public TXT record goes out through the `dns` workflow (not this PR). The seam reads `DKIM_PRIVATE_KEY` plus the settings rows `mail.dkim_domain=tocsin.sh` and `mail.dkim_selector=mcdkim`, and THIS ticket's migration seeds those two rows. Delivered by T1 (migration seeds) and T3 (seam reads). The DNS publish is out of scope (operator owns it).

## Scope
1. Migration `0030_mail_dkim.sql`: seed settings rows `mail.dkim_domain='tocsin.sh'`, `mail.dkim_selector='mcdkim'` (INSERT OR IGNORE). Seed one `sources` row `('mail','mail', enabled=0)` as the warning channel the ticket names (`sources.last_warning`). enabled=0 keeps it out of `runIngesters`, the status page and `/v1/check` coverage (all filter `enabled = 1`).
2. Mail seam (`src/mail/`): a DKIM config resolves from the secret plus the two rows. When all three are set, `MailChannelsMailer` adds `dkim_domain`, `dkim_selector`, `dkim_private_key` to `personalizations[0]` of the send body, and the fake mailer records the three fields in its outbox. When one is missing, the mail goes out unsigned, and the seam writes one warning to `sources.last_warning` of row `mail` (overwrite in place) plus one `console.warn` line that names the missing items, never a value. A missing DKIM item never fails the send.
3. `POST /v1/keys` and `/rotate`: read the two rows in the existing `Promise.all`, pass the DKIM config to `getMailer`, and set a 202 response header `Tocsin-Mail-Dkim: signed | off | incomplete` (`off` = secret not set; `incomplete` = secret set, a row blank).
4. `scripts/launch-check.sh` `keys-signup`: reads that header. `signed` -> `ok keys-signup (dkim signed)`. `off` -> `ok keys-signup (unsigned: DKIM_PRIVATE_KEY not set on the worker)`. `incomplete`, absent or any other value -> `FAIL keys-signup: ...` (the secret is set, or the worker is not this version, and the mail did not carry DKIM).
5. `docs/OPERATING.md` step 4: selector `mcdkim`, TXT `mcdkim._domainkey.tocsin.sh` (`v=DKIM1; k=rsa; p=<public key>`), `_dmarc.tocsin.sh` (`v=DMARC1; p=quarantine`), the one-time `openssl` commands, `wrangler secret put DKIM_PRIVATE_KEY`, the two new settings rows in the table, where the unsigned warning is read. Remove the "Open gap" bullet. `docs/RETENTION.md` `sources`: name the 11th row `mail`.

## Files to touch
- `migrations/0030_mail_dkim.sql` (new)
- `src/mail/dkim.ts` (new): `resolveDkim`, `normalizeDkimKey`, `noteDkimUnsigned`, types
- `src/mail/send.ts`: `MailChannelsMailer` constructor gains `dkim`; body builder adds fields; `getMailer` gains optional `dkim` param
- `src/mail/fake.ts`: `FakeMailer` constructor gains `dkim`; outbox entry carries the three fields when signed
- `src/routes/keys.ts`: two more settings reads in the existing `Promise.all`, resolve DKIM, pass to `getMailer`, header on 202, warning after a successful unsigned send
- `src/env.ts`: `DKIM_PRIVATE_KEY?: string` with comment
- `.env.example`: `DKIM_PRIVATE_KEY=` with comment
- `scripts/launch-check.sh`: `keys-signup` captures headers (`curl -D`), DKIM branch, header comment lines
- `docs/OPERATING.md`: step 4 rewrite, two table rows
- `docs/RETENTION.md`: `sources` paragraph names the `mail` row
- `tests/unit/mail-dkim.tcs-94.test.ts` (new)
- `tests/routes/keys-dkim.tcs-94.test.ts` (new)
- `tests/launch/launch-dkim.tcs-94.test.ts` (new)
- `tests/worker/migrations.tcs-1.test.ts` (TEST-CHANGE, see below)
- `tests/routes/site-plan.tcs-10.test.ts` (TEST-CHANGE, see below)

## Tests that must change
- `tests/worker/migrations.tcs-1.test.ts`: the premise "every `sources` row is one of the 10 enabled ingesters" changes; the read gets `WHERE enabled = 1` (or `kind != 'mail'`) so the 10-ingester assertions stay as they are. The `mail` row is asserted in this ticket's own file.
- `tests/routes/site-plan.tcs-10.test.ts`: the premise "`sources` has 10 rows" changes to 11 (10 ingesters + the disabled `mail` row). Only the number changes; the `WHERE enabled = 1` assertion stays.

## Verify (run, not edited)
- `npm test` (all projects; `api` and `launch` are the ones at risk)
- `npm run typecheck`
- `npm run migrate:local`
- `tests/launch/launch-keys.tcs-83.test.ts` (K1 asserts `ok keys-signup` and `6 of 6 passed`; the local worker has no DKIM secret, so it takes the `off` branch and must stay green unchanged)
- `tests/contract/mail.contract.tcs-64.test.ts` runs in CI because `src/mail/send.ts` changes; constructor stays `(apiKey, dryRun)` compatible.

## Regression risk (grep evidence, no graph on this box)
- `getMailer`: one production caller, `src/routes/keys.ts:112`. New param is optional with default `null`.
- `MailChannelsMailer`: callers `src/mail/send.ts:59` and `tests/contract/mail.contract.tcs-64.test.ts:42,48,55` (2-arg form). Third param optional.
- `readFakeOutbox`: `tests/routes/keys-helpers.tcs-8.ts` and keys tests read `MailMessage[]`; the entry type widens with optional fields only.
- `sources` table readers: `src/ingest/registry.ts:30`, `src/site/data.ts:25`, `src/check/coverage.ts:12` all filter `enabled = 1`; `src/ingest/osv.ts:13` reads by id. Tests that read all rows: `tests/worker/migrations.tcs-1.test.ts:78` and `tests/routes/site-plan.tcs-10.test.ts:41` (must change, above); `tests/cron/retention.tcs-8.test.ts:145` compares before/after only (safe); `tests/launch/local-worker.tcs-14.ts:122` filters enabled (safe).
- `scripts/launch-check.sh` `keys-signup`: `tests/launch/launch-keys.tcs-83.test.ts` K1/K2 (K1 stays green via `off`; K2 is a 503, unchanged).

## Tasks

### T1. Migration: seed the DKIM rows and the warning channel row
`migrations/0030_mail_dkim.sql`: header comment (TCS-94, additive only). `INSERT OR IGNORE INTO settings (key, value) VALUES ('mail.dkim_domain','tocsin.sh')`, same for `('mail.dkim_selector','mcdkim')`, each with a one-line comment. `INSERT OR IGNORE INTO sources (id, kind, enabled) VALUES ('mail','mail',0)` with a comment: warning channel of the mail seam, never an ingester, enabled 0 keeps it off the status page, cron and coverage; retention docs/RETENTION.md. No new table, no index needed (settings and sources reads are by primary key).
VALIDATE: `npm run migrate:local` exits 0, and `npx vitest run --project api tests/routes/keys-dkim.tcs-94.test.ts -t "migration"` passes (rows present with the seeded values; re-running the migration's queries adds no row and keeps an edited value).
SATISFIES: comment 6386594853 "seed them in this ticket's migration"; scope 1 "settings rows `mail.dkim_domain` and `mail.dkim_selector`".

### T2. DKIM resolver and warning writer (`src/mail/dkim.ts`)
- `export interface DkimConfig { domain: string; selector: string; privateKey: string }`.
- `export type DkimState = { state: "signed"; config: DkimConfig } | { state: "off" | "incomplete"; missing: string[] }`.
- `normalizeDkimKey(raw)`: trims; if it holds a `-----BEGIN` armor, strips the BEGIN/END lines; removes all whitespace. Empty result = not set.
- `resolveDkim(secret: string | undefined, domain: string, selector: string): DkimState`. `missing` lists names only: `DKIM_PRIVATE_KEY`, `mail.dkim_domain`, `mail.dkim_selector`. Secret missing -> `off`; secret set and a row blank -> `incomplete`.
- `noteDkimUnsigned(db, missing, nowIso)`: `UPDATE sources SET last_warning = ?, last_run_at = ? WHERE id = 'mail'` with text `mail sent unsigned (no DKIM): not set: <names joined by ", ">`, and `console.warn(JSON.stringify({ lane: "mail", warn: "dkim_unsigned", missing }))`. A failed UPDATE is caught and logged as `{lane:"mail", err}`; it never throws.
- No code fallback for the domain or selector rows beyond `""` (= not set), documented in a comment that names the rows. No literal limit added.
VALIDATE: `npx vitest run --project api tests/unit/mail-dkim.tcs-94.test.ts` passes (cases U1 to U6 below).
SATISFIES: scope 1 "when the worker secret `DKIM_PRIVATE_KEY` and the settings rows ... are set; without them it sends unsigned and writes one warning per run (`sources.last_warning` channel), never a failure".

### T3. The seam sends the fields (`src/mail/send.ts`, `src/mail/fake.ts`, `src/env.ts`, `.env.example`)
- `MailChannelsMailer(apiKey, dryRun = false, dkim: DkimConfig | null = null)`. The body's `personalizations[0]` gets `dkim_domain`, `dkim_selector`, `dkim_private_key` only when `dkim` is non-null. No other body change. The key never enters a log line or an error message.
- `getMailer(env, provider, dkim: DkimConfig | null = null)` passes `dkim` to both the real mailer and the fake.
- `FakeMailer(kv, dkim = null)`: the outbox entry is `{ ...msg }` plus the three fields when signed (`FakeOutboxEntry = MailMessage & Partial<{dkim_domain; dkim_selector; dkim_private_key}>`). `readFakeOutbox` returns `FakeOutboxEntry[]`.
- `src/env.ts`: `DKIM_PRIVATE_KEY?: string` with a comment (wrangler secret; base64 DER or PEM of an RSA key; unset: mail goes out unsigned and the seam writes a warning). Add it to the `Pick` of `getMailer` only if the seam reads it there; it is read in keys.ts and passed through `resolveDkim`.
- `.env.example`: `DKIM_PRIVATE_KEY=` with a comment naming `wrangler secret put DKIM_PRIVATE_KEY` and docs/OPERATING.md step 4.
VALIDATE: `npx vitest run --project api tests/unit/mail-dkim.tcs-94.test.ts -t "body"` passes (U7, U8: `fetch` mocked, body has the three fields with config, no `dkim_` key without it) and `npm run typecheck` exits 0.
SATISFIES: scope 1 "The mail seam sends `dkim_domain`, `dkim_selector` and `dkim_private_key` to MailChannels"; acceptance "the fake mailer receives the three dkim fields".

### T4. Wire the route (`src/routes/keys.ts`)
- Add `getSettingText(db, "mail.dkim_domain", "")` and `getSettingText(db, "mail.dkim_selector", "")` to the existing `Promise.all` (parallel, no new await step). Comment names the rows; `""` is the documented "not set" fallback.
- `const dkim = resolveDkim(c.env.DKIM_PRIVATE_KEY, dkimDomain, dkimSelector)`; `getMailer(c.env, provider, dkim.state === "signed" ? dkim.config : null)`.
- After a successful send: if `dkim.state !== "signed"`, `await noteDkimUnsigned(db, dkim.missing, nowIso)`. The 202 carries header `Tocsin-Mail-Dkim: <state>` (plus `NO_STORE`). A failed send (502 path) writes no warning and sets no header.
- Order is send, then warning: a mail that did not go out writes nothing. The body of the 202 does not change.
VALIDATE: `npx vitest run --project api tests/routes/keys-dkim.tcs-94.test.ts` passes (R1 to R5).
SATISFIES: scope 1 (the production entry point uses the seam with DKIM); acceptance "With the secret and rows set, the fake mailer receives the three dkim fields; without them it receives none and a warning is written; the private key is never logged".

### T5. Launch check asserts DKIM (`scripts/launch-check.sh`)
- In the `keys-signup` block, add `-D "$WORK/keys.headers"` to the curl. Read the header case-insensitively, strip `\r`.
- 202 + `.status == "sent"`: header `signed` -> `ok keys-signup (dkim signed)`; `off` -> `ok keys-signup (unsigned: DKIM_PRIVATE_KEY not set on the worker)`; `incomplete` -> `fail keys-signup "POST /v1/keys: HTTP 202 but DKIM_PRIVATE_KEY is set and a DKIM settings row is blank: mail went out unsigned (docs/OPERATING.md step 4)"`; absent or other -> `fail keys-signup "POST /v1/keys: HTTP 202 with no Tocsin-Mail-Dkim header: the worker is older than TCS-94"`.
- Header comment lines 21 to 22 of the script name the DKIM assertion. TOTAL does not change.
VALIDATE: `npx vitest run --project launch tests/launch/launch-dkim.tcs-94.test.ts tests/launch/launch-keys.tcs-83.test.ts` passes (L1 to L3 and K1 to K4).
SATISFIES: scope 3 "The launch check `keys-signup` line also asserts the sent message carried DKIM fields when the secret is set (fake mailer in tests)".

### T6. Docs (`docs/OPERATING.md`, `docs/RETENTION.md`)
- OPERATING.md step 4 replaced: way (b) is what the seam does. Selector `mcdkim`. One-time key pair:
  `openssl genrsa 2048 | tee priv_key.pem | openssl rsa -outform der | openssl base64 -A > priv_key.txt`
  `echo -n "v=DKIM1; k=rsa; p=" > pub_key_record.txt && openssl rsa -in priv_key.pem -pubout -outform der | openssl base64 -A >> pub_key_record.txt`
  `wrangler secret put DKIM_PRIVATE_KEY < priv_key.txt`, then delete `priv_key.pem` and `priv_key.txt` from disk; never commit them.
  TXT `mcdkim._domainkey.tocsin.sh` = contents of `pub_key_record.txt`; check `dig TXT mcdkim._domainkey.tocsin.sh +short`.
  TXT `_dmarc.tocsin.sh` = `v=DMARC1; p=quarantine`; check with dig.
  Unsigned warning: `wrangler d1 execute DB --remote --command "SELECT last_warning, last_run_at FROM sources WHERE id = 'mail'"`; `last_run_at` there is the time of the latest unsigned send.
  Remove the "Open gap" bullet. Step 6 text: `ok keys-signup (dkim signed)` is the expected line once step 4 is done.
- Settings table: add `mail.dkim_domain | tocsin.sh | Signing domain (d=) of the DKIM signature; blank: unsigned` and `mail.dkim_selector | mcdkim | DKIM selector (s=); blank: unsigned`. The SELECT in step 5 already matches `mail.%`.
- RETENTION.md `sources`: "11 rows today: the 10 ingesters plus `mail` (TCS-94, enabled 0), the warning channel of the mail seam; its `last_warning` and `last_run_at` are overwritten in place by an unsigned send. It does not grow. No delete job."
VALIDATE: `grep -c "mcdkim._domainkey.tocsin.sh\|_dmarc.tocsin.sh\|p=quarantine\|openssl genrsa\|DKIM_PRIVATE_KEY\|mail.dkim_selector" docs/OPERATING.md` prints 6 or more, and `! grep -n "Open gap" docs/OPERATING.md`, and `grep -n "mail" docs/RETENTION.md | grep -i "TCS-94"`.
SATISFIES: scope 2 "docs/OPERATING.md: the selector (`mcdkim`), the TXT record `mcdkim._domainkey.tocsin.sh` with the public key, `_dmarc.tocsin.sh` with `p=quarantine`, and the one-time `openssl` commands to make the key pair"; iron rule 2 (retention rule for the changed table).

### T7. Update the two tests whose premise changes
- `tests/worker/migrations.tcs-1.test.ts:78`: the read gets `WHERE enabled = 1`; all assertions stay.
- `tests/routes/site-plan.tcs-10.test.ts:41`: `toBe(10)` -> `toBe(11)`; test title "10-row" -> "11-row".
VALIDATE: `npx vitest run --project api tests/worker/migrations.tcs-1.test.ts tests/routes/site-plan.tcs-10.test.ts` passes.
SATISFIES: scope 1 "(`sources.last_warning` channel)": the channel row is what changes these premises.

## Edge cases
- Secret is a PEM with newlines, or base64 with a trailing newline: `normalizeDkimKey` gives the same base64 body (U2, U3).
- Secret set to whitespace only: treated as not set -> `off` (U4).
- Row edited to blank `''` or spaces: `getSettingText` returns the fallback `""` -> `incomplete` (U5, L2).
- Settings read fails: `getSettingText` returns `""` -> unsigned + warning, never a 5xx.
- Warning UPDATE fails (row deleted, D1 error): logged, the 202 still goes out (U6).
- MailChannels rejects a bad key (provider 4xx): existing 502 path, existing refund; the logged error text is the provider answer, never the request body. The key is in the body only.
- Real mailer `dryRun` (contract suite): unchanged; no dkim passed there.

## Iron laws applied
- Sortable headers, list-over-cards, drill-down, mobile, native dialogs: n/a, no UI screen changes (the 202 header is API only).
- DB-driven config: domain and selector are settings rows; the secret is a wrangler secret (iron rule 9). The code fallback is `""` = not set, documented next to the row name. No new limit, rate, timeout or cap literal: no hardcoded-knob exposure.
- RLS: n/a (D1, not Supabase). Additive only: two INSERT OR IGNORE settings rows and one INSERT OR IGNORE sources row; no ALTER, no DROP (D20).
- Indexes / EXPLAIN: no new table. New statements: `SELECT value FROM settings WHERE key = ?` (PK, existing helper), `UPDATE sources ... WHERE id = 'mail'` (PK). Test R5 runs `EXPLAIN QUERY PLAN` on the UPDATE and asserts a PK search, no `SCAN sources`.
- No correlated subquery added.
- Retention: `sources` stays a fixed set; the `mail` row is overwritten in place (T6 documents it).
- De-AI: no LLM call site. Model ids: none.
- Dedup before spend: the send stays behind the existing `reserveSend` (TCS-83); this change adds no metered call and no second send.
- Secrets: the fixture key in tests is a non-key string (`fixture-dkim-key-not-a-real-key-<uuid>`), never a PEM, so no scanner hit and no real key. The private key appears in no log, error text or header.
- Scalable tests: mail vendor seam = `src/mail/send.ts`; fake = `src/mail/fake.ts` (MAIL_TRANSPORT=fake, 0 network calls); contract test = `tests/contract/mail.contract.tcs-64.test.ts` (unchanged; runs in CI because the adapter changes). U7/U8 mock `fetch` and assert the mock was called, never the network. Each test uses its own `uniqueEmail` and `nextIp`; launch tests use their own Miniflare worker and D1.

## Performance (POST /v1/keys, an API loader, not a screen)
- Reads: 9 settings reads in ONE `Promise.all` (was 7; +2 for the DKIM rows, parallel), then `reserveSend` (one batch), then `SELECT key_hash`, then the KV put, then the send. Unsigned path only: +1 `UPDATE sources` after the send.
- Expected statements: signed path 7 -> 9 parallel settings reads, no other change; unsigned path +1 UPDATE. Indexes: settings PK, sources PK.
- No skeleton or loading.tsx: no screen.

## Build discipline rules that bite
- D1: mutation check: drop the `dkim` param pass-through in keys.ts -> R1 goes red; remove the `incomplete` branch in launch-check -> L2 goes red.
- D2: R1 to R4 drive the worker's default export (`src/index.ts`) with an env override; L1 to L3 run the real script against a Miniflare worker.
- D3: assert the outbox entry values, the header value and the D1 row, never source text.
- D5: OPERATING.md describes only what the code does after this change.
- D8: PR body carries the operator steps (DNS TXT records, the secret is already set per comment 6386594853) and `[NOTE] not verified here: a real signed mail with dkim=pass` (needs a real inbox).
- D9: a failed send writes no warning and no header; a failed warning write never turns into a failed request, and never into "signed".
- D26: no invented DNS values: the public key value is the operator's; docs show the command that makes it.

## Changed symbols
- function `getMailer`: optional third param `dkim: DkimConfig | null = null`; passes it to both mailers.
- function `MailChannelsMailer` (constructor + `send`): optional third param `dkim`; `send` body adds the three fields to `personalizations[0]` when set. callers: left alone: `tests/contract/mail.contract.tcs-64.test.ts` uses the 2-arg form, unchanged behavior.
- function `FakeMailer` (constructor + `send`): optional second param `dkim`; outbox entry carries the three fields when set.
- function `readFakeOutbox`: return type widens to `FakeOutboxEntry[]` (optional fields only). callers: left alone: existing keys tests read only `MailMessage` fields.
- function `resolveDkim`, `normalizeDkimKey`, `noteDkimUnsigned`: new in `src/mail/dkim.ts`.
- route `POST /v1/keys`: 202 gains header `Tocsin-Mail-Dkim`; reads two more settings rows; unsigned send writes `sources.last_warning` of row `mail`.
- route `POST /v1/keys/rotate`: same as above (same handler).
- verb `scripts/launch-check.sh`: `keys-signup` reads the header; `incomplete`/absent header is now FAIL; ok line gains a suffix.
- format settings rows `mail.dkim_domain`, `mail.dkim_selector`: new.
- format `sources` row `mail`: new (enabled 0, warning channel).

## ASSUMPTIONS
- "writes one warning per run (`sources.last_warning` channel)": the mail seam has no cron run, and `sources` holds only ingesters. Assumed: one new `sources` row `mail` with enabled=0, and each unsigned send overwrites its `last_warning` (one value, never appended) and `last_run_at`. Other reading: a KV key or a settings row for the warning. Rejected, because the ticket names `sources.last_warning`. Cost: two other-ticket tests change one premise each (listed above).
- enabled=0 for the `mail` row: keeps it off the public status page, the ingest cron ("no ingester registered" every 10 minutes) and `/v1/check` coverage. Other reading: enabled=1 so it shows on the status page. Rejected: it would show a non-advisory row as a source and change coverage math.
- A signed send writes nothing to the `mail` row, so an old warning stays until the next unsigned send (same "kept by a run with none" rule as the ingesters, TCS-50). `last_run_at` dates it. Other reading: clear the warning on a signed send; that costs one D1 write per mail.
- "The launch check ... asserts the sent message carried DKIM fields when the secret is set": the launch check runs against a deployed worker and cannot read the mail. Assumed: the worker reports what it did in a 202 header `Tocsin-Mail-Dkim: signed|off|incomplete`. The check FAILs when the secret is set and the mail was not signed (`incomplete`) or the header is missing. It passes with a note when the secret is not set (`off`), because the ticket makes unsigned-without-secret a warning, not a failure. Other reading: a body field, which would change the pinned 202 body. The header discloses only whether DKIM is configured, which any received mail already shows.
- Field placement: the three `dkim_*` fields go in `personalizations[0]` of the MailChannels send body, the documented per-personalization placement. Other reading: top-level fields. If the provider wants top level, it is a one-line move in the body builder; the contract suite in CI (adapter changed) runs a dry-run send.
- Key format: the operator's secret is accepted as base64 DER (what MailChannels documents) or as PEM; PEM armor and whitespace are stripped before the send. Other reading: pass the secret verbatim. Rejected: a PEM with newlines would fail at the provider with no clue in our logs.
- Code fallback for the two rows is `""` (= not set, unsigned), not `tocsin.sh`/`mcdkim`. The ticket says "when ... the settings rows are set". The migration seeds the real values.
- Warning written after a successful send only. A failed send already logs and answers 502; a warning for a mail that never went out would be false (D13).

## System invariants
- (a) Cross-run state: the only new state is the `sources` row `mail` (natural key `id`, PK). Overwritten in place; never pruned; seeded by INSERT OR IGNORE so a re-run keeps an operator edit. DKIM config lives in settings rows (operator knobs) and a wrangler secret.
- (b) External side effect = the MailChannels send. Success: 202 + header; if unsigned, then the warning UPDATE. Failure: existing token delete + `refundSend` + 502, no warning, no header. Not configured (no provider key): existing 503, DKIM not read past the Promise.all, no warning. DKIM state is decided BEFORE the send from the same `dkim` value that builds the mailer, and the header is set from that same value, so "header says signed but fields not sent" cannot happen by construction.
- (c) Negative list (the `signed` decision gates whether a key goes to the provider): must NOT resolve `signed`: secret unset; secret `"   "`; secret `"\n"`; PEM armor lines with an empty body; domain row `''`; selector row `'  '`; domain set and selector missing. Must resolve `signed`: base64 key + both rows; PEM key with CRLF + both rows. U1 to U5 assert every case.
- (d) Neighbors: `reserveSend`/`refundSend` caps (TCS-83): untouched, the warning write is outside their transaction. `runIngesters` cron: skips the row (enabled 0), test R4 asserts the `mail` row is not in the ingest outcomes. Status page `src/site/data.ts` and coverage `src/check/coverage.ts`: filter enabled=1; R4 asserts GET `/v1/status` (or the status page loader) lists no `mail`. Retention crons (`retention.tcs-8`, `deliveries-retention`, `send-counters-retention`): do not touch `sources.last_warning`. Contract workflow `mail-contract.yml`: runs because the adapter changed; the 2-arg constructor still works.

## Requirements coverage
| Requirement (ticket / thread) | Task | Test |
|---|---|---|
| Seam sends `dkim_domain`, `dkim_selector`, `dkim_private_key` when the secret and both rows are set | T2, T3, T4 | U7, R1, L1 |
| Without them it sends unsigned (fake receives none of the fields) | T2, T3, T4 | U8, R2, L3 |
| ... and writes one warning (`sources.last_warning`) | T1, T2, T4 | R2, L2 |
| ... never a failure (still 202) | T4 | R2, U6 |
| Private key never logged (grep the fake log) | T2, T3, T4 | R3 |
| Rows `mail.dkim_domain=tocsin.sh`, `mail.dkim_selector=mcdkim` seeded in this ticket's migration (comment 6386594853) | T1 | R5 (migration case) |
| Seam reads `DKIM_PRIVATE_KEY` (comment 6386594853) | T3, T4 | R1 |
| OPERATING.md: selector `mcdkim`, TXT `mcdkim._domainkey.tocsin.sh`, `_dmarc.tocsin.sh` `p=quarantine`, openssl commands | T6 | T6 VALIDATE grep |
| OPERATING.md no longer states the open gap (negative) | T6 | T6 VALIDATE `! grep "Open gap"` |
| Launch check `keys-signup` asserts DKIM fields when the secret is set | T5 | L1, L2 |
| Launch check does not fail when the secret is not set (negative) | T5 | L3, K1 (TCS-83, unchanged) |

## Acceptance tests
`tests/unit/mail-dkim.tcs-94.test.ts` (api project, no network):
- U1 `resolveDkim("AAAA", "tocsin.sh", "mcdkim")` -> `signed` with config `{domain:"tocsin.sh", selector:"mcdkim", privateKey:"AAAA"}`.
- U2 PEM key with `\r\n` and BEGIN/END lines -> `signed`, `privateKey` equals the joined base64 body.
- U3 base64 key with a trailing `\n` -> trimmed.
- U4 negatives: secret `undefined`, `"   "`, `"\n"`, armor-only PEM -> `off`, `missing` contains `DKIM_PRIVATE_KEY`.
- U5 negatives: secret set, domain `""` -> `incomplete` with `missing` `["mail.dkim_domain"]`; selector `""` -> `["mail.dkim_selector"]`; both blank -> both names.
- U6 `noteDkimUnsigned` with a stub `db` whose `prepare().bind().run()` rejects -> resolves, logs one `{lane:"mail"}` error line, no throw.
- U7 body: `vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", {status: 202}))`; `new MailChannelsMailer("k", false, cfg).send(msg)`; parsed body `personalizations[0]` has the three fields with the config values.
- U8 body: same with `dkim` omitted -> `JSON.stringify(body)` contains no `dkim_`.
- U9 failure: `fetch` mocked to `new Response("bad", {status: 500})`, real mailer with config -> rejects with `MailSendError` whose message does not contain the key.

`tests/routes/keys-dkim.tcs-94.test.ts` (api project; drives `worker.fetch` from `src/index.ts` with `{...env, DKIM_PRIVATE_KEY: FIXTURE}` or plain `env`; each test its own `uniqueEmail` and IP):
- R1 secret set + seeded rows: 202, header `Tocsin-Mail-Dkim: signed`, outbox entry has `dkim_domain === "tocsin.sh"`, `dkim_selector === "mcdkim"`, `dkim_private_key === FIXTURE`.
- R2 no secret: 202, header `off`, outbox entry has no `dkim_*` key, `SELECT last_warning FROM sources WHERE id='mail'` equals `mail sent unsigned (no DKIM): not set: DKIM_PRIVATE_KEY` (every unsigned writer in the suite writes this same text, so parallel tests cannot change the value).
- R3 secret set: spy on `console.log`, `console.warn` and `console.error` for one signed request; the joined spy output does not contain FIXTURE. Unsigned request: the `console.warn` line names `DKIM_PRIVATE_KEY` and holds no key value. The provider-failure path is covered in the unit file (U9: real mailer with config, `fetch` mocked to a 500 whose body is "bad"; the thrown `MailSendError` message does not contain the key). No test edits the shared `mail.from_address` row.
- R4 the `mail` row: `enabled = 0`; `runIngesters` outcomes (fetch mocked to reject) contain no `source: "mail"`; the status loader query `STATUS_SOURCES_SQL` returns no `mail` id.
- R5 migration: `mail.dkim_domain = 'tocsin.sh'`, `mail.dkim_selector = 'mcdkim'`; re-running `0030_mail_dkim.sql` queries from `env.TEST_MIGRATIONS` adds no row and keeps a value set by the test in a unique way (test sets selector to `x`, re-runs, reads `x`, restores `mcdkim` in `finally`; this is the only settings write in the suite, and it is restored inside one test). `EXPLAIN QUERY PLAN` of the warning UPDATE shows a PK search on `sources`, no `SCAN sources`.

`tests/launch/launch-dkim.tcs-94.test.ts` (launch project; own Miniflare worker each, so own D1 and KV):
- L1 `startLocalWorker({ text: { MAIL_TRANSPORT: "fake", DKIM_PRIVATE_KEY: FIXTURE } })`, `KEYS_CHECK=1`: output contains `ok keys-signup (dkim signed)`, `6 of 6 passed`, exit 0; outbox entry has the three fields; `SELECT last_warning FROM sources WHERE id='mail'` is NULL (signed writes nothing).
- L2 same worker setup, then `UPDATE settings SET value = '' WHERE key = 'mail.dkim_selector'` in that worker's D1: output matches `FAIL keys-signup: POST /v1/keys: HTTP 202 but DKIM_PRIVATE_KEY is set`, `5 of 6 passed`, exit 1; outbox entry has no `dkim_*`; `last_warning` names `mail.dkim_selector`.
- L3 no secret: output contains `ok keys-signup (unsigned: DKIM_PRIVATE_KEY not set on the worker)`, exit 0; `last_warning` names `DKIM_PRIVATE_KEY`.
- All three: the script's whole output does not contain FIXTURE; `w.unknownUrls` is empty (0 network calls).

Existing suites at regression risk: `tests/launch/launch-keys.tcs-83.test.ts`, `tests/routes/keys*.test.ts` (tcs-8, tcs-64, tcs-83), `tests/worker/migrations.tcs-1.test.ts`, `tests/routes/site-plan.tcs-10.test.ts`, `tests/routes/status-ledger.tcs-50.test.ts`, `tests/cron/warnings.tcs-50.test.ts`, `tests/cron/retention.tcs-8.test.ts`, `tests/contract/mail.contract.tcs-64.test.ts` (CI only).

## QA screens
- No browser screen changes. API check only: `POST https://tocsin.sh/v1/keys` with an owned inbox, read the `Tocsin-Mail-Dkim` header (expected `signed` in prod once deployed, since the secret is set), then read the received mail for `DKIM-Signature: ... d=tocsin.sh; s=mcdkim` and `dkim=pass`. That is the operator's step 6 run (`KEYS_CHECK=1 KEYS_CHECK_EMAIL=<inbox> bash scripts/launch-check.sh`). `[NOTE] not verified here: a real inbox and the published TXT record`.

## Entry points
no user-facing entry point (API header and operator docs only; the key sign-up flow at `POST /v1/keys` keeps its request and body).

```pr-body-requires
TEST-CHANGE: <- Tests that must change (migrations.tcs-1, site-plan.tcs-10)
## ASSUMPTIONS <- plan ASSUMPTIONS section
DKIM_PRIVATE_KEY <- new env var: list where it must be set (wrangler secret on the main worker; already set per comment 6386594853; not needed in CI)
```

## Design collision check (BH-5791)

Checked 10 listed and 0 derived symbols against main 119796162b26..119796162b26 and 0 open PRs.
- `none`: no checked symbol changed after the base.

## Size
FILES: 8
LINES: 170
DIFF_KB: 30

KIND: feature
SIZE: M
