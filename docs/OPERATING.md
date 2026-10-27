# Operating

One-time operator steps for a production deploy. Do them once per account and domain.

## Mail for API key sign-up

`POST /v1/keys` and `POST /v1/keys/rotate` mail a confirm link through Resend (`src/mail/resend.ts`, selected in `src/mail/send.ts` by the settings row `mail.provider`, seed `resend` since migration 0031). Until the secret `RESEND_API_KEY` is set, both routes log `mail_not_configured`, answer 503 and mail nothing.

Resend signs each mail with the DKIM key of the verified domain. The seam sends Resend no DKIM fields, and the route writes no unsigned-mail warning for it.

### DNS state of tocsin.sh

These records are live (operator state of 2026-10-24, set with the cf CLI on the liorwn Cloudflare account). tocsin.sh is a domain of the CTOx Resend team, region us-east-1, return-path `send`.

| Record | Name | Value |
|---|---|---|
| TXT | `resend._domainkey.tocsin.sh` | Resend DKIM public key (the value Resend shows for the domain) |
| CNAME | `send.tocsin.sh` | `send.forge.rmta.net` (DNS only) |
| CNAME | `rsend.tocsin.sh` | `rsend.forge.rmta.net` (DNS only) |
| TXT | `tocsin.sh` (SPF) | `v=spf1 -all` |
| TXT | `_dmarc.tocsin.sh` | `p=quarantine; adkim=s; aspf=r` (relaxed SPF alignment: the return-path is a subdomain) |

The MailChannels SPF include and the TXT record `mcdkim._domainkey.tocsin.sh` are removed. The worker secret `DKIM_PRIVATE_KEY` and the settings rows `mail.dkim_domain` and `mail.dkim_selector` are not read while `mail.provider = resend`. To publish a new record, use the `dns` workflow (`.github/workflows/dns.yml`) or `cf dns records create`.

### Steps

1. Open the domain tocsin.sh in the Resend dashboard (CTOx team). Wait until it shows Verified. Resend does not deliver mail from an unverified domain.
2. Create a sending-only API key in Resend, restricted to tocsin.sh. Set it on the main worker: `wrangler secret put RESEND_API_KEY`. This is the name `src/env.ts` and `getMailer` read. If the secret is not set, the route logs `mail_not_configured` and answers 503.
3. Set the same key as the GitHub Actions secret `RESEND_API_KEY`. `.github/workflows/mail-contract.yml` reads it for the Resend contract suite (`tests/contract/mail-resend.contract.tcs-97.test.ts`). Without it, the Resend tests of that suite skip. Resend has no dry run: the suite sends one real mail per run to Resend's test inbox `delivered@resend.dev` (main plus nightly, about 30 to 60 of the 3,000 free mails a month).
4. Check the settings rows the route reads. The migrations seed them; change a value in place with `wrangler d1 execute DB --remote --command "UPDATE settings SET value = '<value>' WHERE key = '<key>'"`. Read them with:

   ```
   wrangler d1 execute DB --remote --command "SELECT key, value FROM settings WHERE key LIKE 'keys.%' OR key LIKE 'mail.%' OR key LIKE 'retention.send_counters_%'"
   ```

   | Key | Seed | What it does |
   |---|---|---|
   | `keys.confirm_ttl_seconds` | 3600 | Life of a mailed link (never below 60) |
   | `keys.ip_sends_per_hour` | 10 | Mails per client IP per clock hour |
   | `keys.email_sends_per_hour` | 3 | Mails per email address per clock hour |
   | `mail.daily_send_cap` | 500 | Mails per UTC day, all callers |
   | `mail.provider` | resend | Mail provider: `resend` or `mailchannels`; any other value answers 503 |
   | `mail.from_address` | keys@tocsin.sh | From address of the mail |
   | `keys.confirm_base_url` | https://tocsin.sh | Host of the mailed link |
   | `mail.dkim_domain` | tocsin.sh | MailChannels only: signing domain (d=) of the DKIM signature; blank: unsigned |
   | `mail.dkim_selector` | mcdkim | MailChannels only: DKIM selector (s=); blank: unsigned |
   | `keys.max_body_bytes` | 4096 | Largest request body on the key routes |
   | `keys.anon_rate_per_minute` | 5 | Requests per IP per minute on the key routes |
   | `watchlists.ip_rate_per_minute` | 300 | Requests per IP per minute on the watch list routes |
   | `retention.send_counters_days` | 2 | Age after which the daily job deletes a send counter row |
   | `retention.send_counters_batch` | 5000 | Most send counter rows one daily run deletes |
   | `retention.send_counters_dry_run` | 0 | Any value but 0 counts and deletes nothing |

   The three send caps are counted in the D1 table `send_counters`, one row per window, reserved before each send (docs/RETENTION.md).
5. Run the launch check once with the sign-up check on, and an inbox you own:

   ```
   KEYS_CHECK=1 KEYS_CHECK_EMAIL=<an inbox you own> bash scripts/launch-check.sh
   ```

   The line `ok keys-signup (dkim signed by the provider)` means `POST /v1/keys` answered 202, Resend took the mail, and the worker sent no DKIM fields because Resend signs. It is the expected line. Its `Tocsin-Mail-Dkim` response header (`provider`) tells the check what the worker did. To confirm the signature itself, read the received mail: its `DKIM-Signature` header has `d=tocsin.sh; s=resend`, and its authentication results show `dkim=pass`. `FAIL keys-signup: POST /v1/keys: HTTP 503` means `RESEND_API_KEY` is not set, or the daily cap is hit. A 502 from the route means Resend refused the mail (for example, the domain is not verified yet); the worker log line holds Resend's status and message. This check sends one real mail, so it is off by default and the scheduled launch check does not run it.

### Switching back to MailChannels

MailChannels stays as the other adapter. It needs a MailChannels account. To use it:

1. Set `mail.provider` to `mailchannels`: `wrangler d1 execute DB --remote --command "UPDATE settings SET value = 'mailchannels' WHERE key = 'mail.provider'"`.
2. Set the secret on the main worker: `wrangler secret put MAILCHANNELS_API_KEY`.
3. Add the MailChannels domain lockdown TXT record `_mailchannels.tocsin.sh` with the value `v=mc1 auth=<your MailChannels account id>`. Source: https://docs.mailchannels.com/email-api/domain-lockdown
4. Add `include:relay.mailchannels.net` to the SPF TXT record of `tocsin.sh` (do it together with step 3: SPF without domain lockdown lets other MailChannels accounts send as the domain).
5. Set up DKIM. The MailChannels send request carries `dkim_domain`, `dkim_selector` and `dkim_private_key` (way (b) of https://docs.mailchannels.com/email-api/configuring-dkim). `src/mail/dkim.ts` reads the key from the secret `DKIM_PRIVATE_KEY` and the domain and selector from the rows `mail.dkim_domain` and `mail.dkim_selector`. Make the key pair once, on your own machine:

   ```
   openssl genrsa 2048 | tee priv_key.pem | openssl rsa -outform der | openssl base64 -A > priv_key.txt
   echo -n "v=DKIM1; k=rsa; p=" > pub_key_record.txt && openssl rsa -in priv_key.pem -pubout -outform der | openssl base64 -A >> pub_key_record.txt
   ```

   Set the private key: `wrangler secret put DKIM_PRIVATE_KEY < priv_key.txt` (base64 DER or a PEM), then delete both key files. Never commit them. Add the TXT record `mcdkim._domainkey.tocsin.sh` with the contents of `pub_key_record.txt`.

   With MailChannels, if the secret or one of the two rows is not set, the mail goes out unsigned and the send does not fail. Each unsigned send writes one warning that names the missing items (never a value). Read it with `wrangler d1 execute DB --remote --command "SELECT last_warning, last_run_at FROM sources WHERE id = 'mail'"`. The launch check then prints `ok keys-signup (dkim signed)` when signed, `ok keys-signup (unsigned: DKIM_PRIVATE_KEY not set on the worker)` with no secret, and `FAIL keys-signup: POST /v1/keys: HTTP 202 but DKIM_PRIVATE_KEY is set and a DKIM settings row is blank` when a row is blank.

## X posts of critical runtime advisories

The `*/10` cron posts one short message to the Tocsin X account @tocsinagent when a critical runtime advisory lands (TCS-106, `src/cron/social.ts`). It is a product account, never a person's account. The text is built from the advisory record, with a link to its page; no LLM writes it. Example: `PHP 8.2.x, 8.3.x, 8.4.x, 8.5.x: RCE via OOM corruption. Severity critical, fixed in 8.2.35, 8.3.36, 8.4.27, 8.5.12. https://tocsin.sh/advisories/<id>`.

An advisory posts once, on first sight, when all of these are true: one of its sources is in `social.x.sources`; its severity is at or above `social.x.min_severity`; it was published less than `social.x.max_age_hours` ago; it is not withdrawn. A later update to the advisory never posts it again. The lane writes the `social_posts` row before it calls X, so a second tick never calls X for the same advisory. Each post with a link costs about $0.20.

### Steps

1. In the X developer portal, sign in as @tocsinagent and create an app with Read and Write permission. Generate the consumer key and secret, and the access token and secret of @tocsinagent (OAuth 1.0a user context).
2. Set the four secrets on the main worker. These are the names `src/env.ts` and `getXClient` (`src/social/x.ts`) read:

   ```
   wrangler secret put X_CONSUMER_KEY
   wrangler secret put X_CONSUMER_SECRET
   wrangler secret put X_ACCESS_TOKEN
   wrangler secret put X_ACCESS_TOKEN_SECRET
   ```

   If any one is not set, the lane posts nothing and `GET /v1/status` shows `social.last_error` `not_configured`.
3. Set the same four values as GitHub Actions secrets. `.github/workflows/social-contract.yml` reads them for the contract suite (`tests/contract/social-x.contract.tcs-106.test.ts`). It runs on main, nightly, and on a PR that changes `src/social/x.ts` or `src/social/oauth1.ts`. Each run posts one `[contract test]` message to @tocsinagent and deletes it at once. Without the secrets, the suite skips. A billing answer (no credits on the X account), a 429, a 5xx or a network error is a vendor failure: the test skips with the reason and prints one `{"lane":"social-contract","alert":"vendor_failure",...}` line.
4. Turn the lane on. The seed is `0` (off):

   ```
   wrangler d1 execute DB --remote --command "UPDATE settings SET value = '1' WHERE key = 'social.x.enabled'"
   ```

   While the flag is off, each tick moves the lane's watermark (the `match_cursors` row `social:x`) to the newest advisory. So turning it on never posts a backlog: only advisories that land after that tick can post. To turn it off, set the value to `0`.
5. Check the lane with `curl -s https://tocsin.sh/v1/status | jq .social`. It answers `{"enabled": true, "posted_24h": <n>, "last_error": null}`.

### Settings

Change a value in place with `wrangler d1 execute DB --remote --command "UPDATE settings SET value = '<value>' WHERE key = '<key>'"`. Read them with `wrangler d1 execute DB --remote --command "SELECT key, value FROM settings WHERE key LIKE 'social.%'"`.

| Key | Seed | What it does |
|---|---|---|
| `social.x.enabled` | 0 | `1` posts; any other value posts nothing |
| `social.x.min_severity` | critical | Lowest severity that posts: `critical`, `high`, `medium` or `low`. An unknown value acts as `critical` |
| `social.x.sources` | node-runtime,php-runtime,python-runtime,deno-runtime,bun-runtime,osv-go-toolchain | Sources that post. `osv-go-toolchain` is OSV `Go` rows on the Go toolchain (`stdlib`, `toolchain`, `cmd/*`), never a Go module |
| `social.x.daily_cap` | 10 | X calls per UTC day (first attempts). Over the cap, rows wait as `pending` and post the next UTC day |
| `social.x.max_age_hours` | 72 | An advisory published longer ago never posts |
| `social.x.scan_rows` | 200 | Advisories read per runtime per tick; the rest are read on the next tick |
| `social.x.max_attempts` | 3 | Attempts after a 429, 5xx or billing answer before the row is `failed` |
| `social.x.retry_seconds` | 600 | Wait before the next attempt after a 429, 5xx or billing answer |
| `social.x.lease_seconds` | 300 | A `sending` row older than this ends `failed` (`unknown_outcome`) and is never sent again |
| `social.x.timeout_ms` | 10000 | Timeout of one X call |
| `social.x.max_chars` | 280 | Weighted length limit of one post |
| `social.x.url_chars` | 23 | X weight of one link |
| `social.x.min_summary_chars` | 60 | The summary is cut to no fewer chars before the fixed-version list is shortened |
| `social.retention_days` | 365 | Age after which the daily job moves an `ok`, `empty` or `failed` row to `social_posts_archive` |
| `social.retention_batch` | 5000 | Most rows one daily run moves |
| `social.retention_dry_run` | 0 | Any value but 0 counts and moves nothing |

### Row states and errors

Read the rows with `wrangler d1 execute DB --remote --command "SELECT advisory_id, status, attempts, posted_id, error FROM social_posts ORDER BY id DESC LIMIT 20"`.

| Status | Meaning |
|---|---|
| `pending` | Written, waiting for room under the daily cap or for its retry time |
| `sending` | Claimed for one X call |
| `ok` | X answered with a post id (`posted_id`) |
| `empty` | X answered 2xx with no post id. Terminal: never sent again |
| `failed` | Terminal: never sent again by the lane |

| `error` / `social.last_error` | Meaning |
|---|---|
| `not_configured` | An X secret is not set (step 2). Nothing was written or sent |
| `x answered 401: ...` or `x answered 403: ...` | X refused the credentials or the post (for example, a duplicate text). Terminal |
| `billing: x answered 402: ...` or `billing: x answered 403: ...` | The X account has no credits (a 402, or a 403 that names credits, billing, payment or enrollment). No post was made. The row retries until `social.x.max_attempts`. Buy credits in the X developer portal, then replay the row |
| `x answered 429: ...` or `x answered 5xx: ...` | Rate limit or an X fault. The row retries until `social.x.max_attempts` |
| `x answered 2xx with no post id` | The `empty` state |
| `network` | No answer (timeout or connection error). Terminal: the post may have gone out, and a retry could post twice |
| `unknown_outcome` | A `sending` row passed its lease (the worker stopped during the call). Terminal for the same reason |

`error` holds at most 200 chars of X's answer, never a header or a token.

### Replay one advisory by hand

```
curl -s -X POST https://tocsin.sh/v1/internal/social/replay \
  -H "Authorization: Bearer $IMPORT_TOKEN" -H "Content-Type: application/json" \
  -d '{"advisory_id": "tcs_..."}'
```

The bearer is the worker secret `IMPORT_TOKEN`. No header answers 401, a wrong token 403. An advisory whose row is `ok` (in `social_posts` or in the archive) answers `200 {"status": "ok", "changed": false}` and writes nothing. Otherwise the route writes the row as `pending` with fresh text, sends it once, and answers `200 {"status": "<row status>", "changed": true}`. The replay does not check the severity or source rules. These answers write nothing: 404 (no such advisory), 409 (withdrawn advisory, `social.x.enabled` is not `1`, or a post in flight), 503 (an X secret is not set), 429 (the daily cap is reached).

## Claude Code plugin directory

The plugin is in `plugins/tocsin/`, and the repo is its marketplace (`.claude-plugin/marketplace.json`). Users install it with `claude plugin install tocsin --marketplace Fortunian/tocsin`. A listing in the Claude plugin directory is a separate step. It is a human step: no workflow or script in this repo submits the plugin.

### Steps

1. Run `bash scripts/validate-plugin.sh` on a machine that has the `claude` CLI. Both strict validations must show `Validation passed` and the script must exit 0. CI skips this check because GitHub runners have no `claude` CLI.
2. Make sure `plugins/tocsin/.claude-plugin/plugin.json` has the same `version` as `packages/cli/package.json`. `tests/plugin/plugin-manifest.tcs-100.test.ts` fails when they differ.
3. Sign in at https://claude.ai/directory/manage with an account on a paid plan. The ticket that added the plugin (TCS-100) states that a directory submission needs a paid plan.
4. Read the pre-submission checklist linked on the submission page, and fix each item it names before you submit.
5. Submit the repository `Fortunian/tocsin` with the plugin path `plugins/tocsin`.
6. Record the submission date and the review result in the ticket.
