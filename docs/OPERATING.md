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
