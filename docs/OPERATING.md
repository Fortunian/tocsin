# Operating

One-time operator steps for a production deploy. Do them once per account and domain.

## Mail for API key sign-up

`POST /v1/keys` and `POST /v1/keys/rotate` mail a confirm link through MailChannels (`src/mail/send.ts`). Until the steps below are done, both routes answer 503 and mail nothing.

1. Set the provider secret on the main worker: `wrangler secret put MAILCHANNELS_API_KEY`. This is the name `src/env.ts` and `getMailer` read. If the secret is not set, the route logs `mail_not_configured` and answers 503.
2. Add the MailChannels domain lockdown TXT record on the sending domain. Name: `_mailchannels.tocsin.sh`. Value: `v=mc1 auth=<your MailChannels account id>`. Get the account id from the MailChannels console. Check it with `dig TXT _mailchannels.tocsin.sh +short`. Source: https://docs.mailchannels.com/email-api/domain-lockdown
3. Add `include:relay.mailchannels.net` to the SPF TXT record of `tocsin.sh`. If the domain has no SPF record, create `v=spf1 include:relay.mailchannels.net ~all`. Do this together with step 2: SPF without domain lockdown lets other MailChannels accounts send as the domain.
4. Set up DKIM for `keys@tocsin.sh`. The send request carries `dkim_domain`, `dkim_selector` and `dkim_private_key` (way (b) of https://docs.mailchannels.com/email-api/configuring-dkim). `src/mail/dkim.ts` reads the key from the secret `DKIM_PRIVATE_KEY` and the domain and selector from the settings rows `mail.dkim_domain` (seed `tocsin.sh`) and `mail.dkim_selector` (seed `mcdkim`).
   1. Make the key pair once, on your own machine:

      ```
      openssl genrsa 2048 | tee priv_key.pem | openssl rsa -outform der | openssl base64 -A > priv_key.txt
      echo -n "v=DKIM1; k=rsa; p=" > pub_key_record.txt && openssl rsa -in priv_key.pem -pubout -outform der | openssl base64 -A >> pub_key_record.txt
      ```

   2. Set the private key on the main worker: `wrangler secret put DKIM_PRIVATE_KEY < priv_key.txt`. The seam accepts base64 DER (this file) or a PEM. Then delete `priv_key.pem` and `priv_key.txt` from disk. Never commit them.
   3. Add the TXT record `mcdkim._domainkey.tocsin.sh` with the contents of `pub_key_record.txt` as its value. Check it with `dig TXT mcdkim._domainkey.tocsin.sh +short`.
   4. Add the TXT record `_dmarc.tocsin.sh` with the value `v=DMARC1; p=quarantine`. Check it with `dig TXT _dmarc.tocsin.sh +short`.

   If the secret or one of the two rows is not set, the mail goes out unsigned and the send does not fail. Each unsigned send writes one warning that names the missing items (never a value). Read it with:

   ```
   wrangler d1 execute DB --remote --command "SELECT last_warning, last_run_at FROM sources WHERE id = 'mail'"
   ```

   `last_run_at` is the time of the latest unsigned send. A signed send does not clear the warning.
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
   | `mail.dkim_domain` | tocsin.sh | Signing domain (d=) of the DKIM signature; blank: unsigned |
   | `mail.dkim_selector` | mcdkim | DKIM selector (s=); blank: unsigned |
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

   The line `ok keys-signup (dkim signed)` means `POST /v1/keys` answered 202, the provider took the mail, and the request carried the DKIM fields; it is the expected line once step 4 is done. Its `Tocsin-Mail-Dkim` response header tells the check what the worker did. `ok keys-signup (unsigned: DKIM_PRIVATE_KEY not set on the worker)` means the mail went out with no DKIM signature. `FAIL keys-signup: POST /v1/keys: HTTP 202 but DKIM_PRIVATE_KEY is set and a DKIM settings row is blank` means the secret is set but `mail.dkim_domain` or `mail.dkim_selector` is blank. To confirm the signature itself, read the received mail: its `DKIM-Signature` header has `d=tocsin.sh; s=mcdkim`, and its authentication results show `dkim=pass`. `FAIL keys-signup: POST /v1/keys: HTTP 503` means steps 1 to 4 are not complete, or the daily cap is hit. This check sends one real mail, so it is off by default and the scheduled launch check does not run it.
