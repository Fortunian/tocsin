# Operating

One-time operator steps for a production deploy. Do them once per account and domain.

## Mail for API key sign-up

`POST /v1/keys` and `POST /v1/keys/rotate` mail a confirm link through MailChannels (`src/mail/send.ts`). Until the steps below are done, both routes answer 503 and mail nothing.

1. Set the provider secret on the main worker: `wrangler secret put MAILCHANNELS_API_KEY`. This is the name `src/env.ts` and `getMailer` read. If the secret is not set, the route logs `mail_not_configured` and answers 503.
2. Add the MailChannels domain lockdown TXT record on the sending domain. Name: `_mailchannels.tocsin.sh`. Value: `v=mc1 auth=<your MailChannels account id>`. Get the account id from the MailChannels console. Check it with `dig TXT _mailchannels.tocsin.sh +short`. Source: https://docs.mailchannels.com/email-api/domain-lockdown
3. Add `include:relay.mailchannels.net` to the SPF TXT record of `tocsin.sh`. If the domain has no SPF record, create `v=spf1 include:relay.mailchannels.net ~all`. Do this together with step 2: SPF without domain lockdown lets other MailChannels accounts send as the domain.
4. Set up DKIM for `keys@tocsin.sh` as MailChannels documents it: https://docs.mailchannels.com/email-api/configuring-dkim. MailChannels offers two ways. (a) MailChannels makes and stores the key pair for the domain (https://docs.mailchannels.com/api-reference/dkim/create-dkim-key-pair); publish the DNS TXT record its answer gives. (b) The send request carries `dkim_domain`, `dkim_selector` and `dkim_private_key`.
   - Open gap: `src/mail/send.ts` sends no `dkim_*` fields today. This repo does not confirm that a key stored with way (a) signs a request that has no `dkim_*` fields. After step 4, send one test mail (step 6) and read its `DKIM-Signature` header and `dkim=pass` in the received message. If the mail is not signed, the seam needs a change; file a ticket.
5. Check the settings rows the route reads. The migrations seed them; change a value in place with `wrangler d1 execute DB --remote --command "UPDATE settings SET value = '<value>' WHERE key = '<key>'"`. Read them with:

   ```
   wrangler d1 execute DB --remote --command "SELECT key, value FROM settings WHERE key LIKE 'keys.%' OR key LIKE 'mail.%' OR key LIKE 'retention.send_counters_%'"
   ```

   | Key | Seed | What it does |
   |---|---|---|
   | `keys.confirm_ttl_seconds` | 3600 | Life of a mailed link (never below 60) |
   | `keys.ip_sends_per_hour` | 10 | Mails per client IP per clock hour |
   | `keys.email_sends_per_hour` | 3 | Mails per email address per clock hour |
   | `mail.daily_send_cap` | 500 | Mails per UTC day, all callers |
   | `mail.provider` | mailchannels | Mail provider; any other value answers 503 |
   | `mail.from_address` | keys@tocsin.sh | From address of the mail |
   | `keys.confirm_base_url` | https://tocsin.sh | Host of the mailed link |
   | `keys.max_body_bytes` | 4096 | Largest request body on the key routes |
   | `keys.anon_rate_per_minute` | 5 | Requests per IP per minute on the key routes |
   | `watchlists.ip_rate_per_minute` | 300 | Requests per IP per minute on the watch list routes |
   | `retention.send_counters_days` | 2 | Age after which the daily job deletes a send counter row |
   | `retention.send_counters_batch` | 5000 | Most send counter rows one daily run deletes |
   | `retention.send_counters_dry_run` | 0 | Any value but 0 counts and deletes nothing |

   The three send caps are counted in the D1 table `send_counters`, one row per window, reserved before each send (docs/RETENTION.md).
6. Run the launch check once with the sign-up check on, and an inbox you own:

   ```
   KEYS_CHECK=1 KEYS_CHECK_EMAIL=<an inbox you own> bash scripts/launch-check.sh
   ```

   The line `ok keys-signup` means `POST /v1/keys` answered 202 and the provider took the mail. `FAIL keys-signup: POST /v1/keys: HTTP 503` means steps 1 to 4 are not complete, or the daily cap is hit. This check sends one real mail, so it is off by default and the scheduled launch check does not run it.
