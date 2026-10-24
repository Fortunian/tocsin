# Tocsin API

Base URL: `https://tocsin.sh`. Every answer is JSON in UTF-8 unless this page says otherwise. Reads need no account and no key.

## Endpoints

| Method and path | What it answers |
|---|---|
| `GET /v1/health` | `{ "ok": true, "version": "<x.y.z>" }` when the worker is up. |
| `GET /v1/events` | One page of the feed: `{ "events": [...], "next_cursor": <int>, "has_more": <bool> }`. |
| `GET /v1/events/{id}` | One advisory by its Tocsin id. 404 when it does not exist. |
| `GET /v1/events/cve/{cve}` | The earliest advisory, by feed cursor, that lists the CVE id (`CVE-YYYY-NNNN`) in any of its `cve_ids`, not only the first one. `GET /cve/{cve}` with `Accept: application/json` lists every such advisory. 400 for a malformed id, 404 when none. |
| `GET /advisories/{id}` | One advisory as an HTML page. HTML is the default: no `Accept` header, `*/*` and any `Accept` that names `text/html` get HTML. An `Accept` that names `application/json` (any q-value) and not `text/html` gets the advisory JSON. ETag with 304, `Cache-Control: public, max-age=300`. 404 when it does not exist. |
| `GET /cve/{cve}` | Every advisory that carries a CVE id (any of its `cve_ids`), as one HTML page. `Accept: application/json` returns `{ "cve", "advisories": [...] }`. 404 when none. |
| `GET /sitemap.xml` | Every advisory page and every CVE page, with no `lastmod`. Past one file (50,000 URLs at most) it is an index of `/sitemap-{n}.xml` files. |
| `GET /v1/check` | Which runtimes are affected, from query parameters such as `?node=24.22.0&php=8.4.26`. |
| `POST /v1/check` | Which dependencies are affected, from lockfiles (multipart) or JSON. |
| `POST /v1/keys` | Mails a one-time link to the email. The answer is 202 and holds no key. See [API keys and watch lists](#api-keys-and-watch-lists). |
| `GET /v1/keys/confirm?token=...` | The mailed link. An HTML page with one Confirm button. It changes nothing: no key, no spent token. |
| `POST /v1/keys/confirm` | Spends the token once and answers the API key. Form body `token=tct_...` (the button) or JSON `{"token": "tct_..."}`. |
| `POST /v1/keys/rotate` | Mails a link that replaces the API key of the email. |
| `POST /v1/watchlists`, `GET /v1/watchlists`, `DELETE /v1/watchlists/{id}` | Create, list and delete your watch lists. Needs an API key. |
| `GET /v1/watchlists/{id}` | One watch list with its filter, its webhook delivery health and its stored dependency count. Needs an API key. |
| `POST /v1/watchlists/{id}/lockfile` | Stores the dependency set of a watch list from lockfiles (the same bodies as `POST /v1/check`) and answers the check result. Needs an API key. See [Watch a lockfile](#watch-a-lockfile). |
| `PATCH /v1/watchlists/{id}` | Sets how a watch list is delivered: `poll` or `webhook`. Needs an API key. |
| `POST /v1/watchlists/{id}/resume` | Starts webhook delivery again on a paused watch list. Needs an API key. |
| `GET /v1/watchlists/{id}/events` | New events on one watch list, from its stored cursor. Needs an API key. |
| `GET /v1/watchlists/{id}/deliveries` | The 100 newest webhook deliveries of one watch list, with status. Needs an API key. |
| `GET /v1/status` | Each enabled source with `last_run_at`, `last_ok_at` and `last_error`, plus the newest feed `cursor`. |
| `GET /.well-known/tocsin.json` | The discovery document: every endpoint URL and the MCP URL. |
| `GET /llms.txt` | A plain-text guide for agents. |
| `GET /schema/advisory.v1.json` | The JSON Schema of one advisory. |
| MCP `https://mcp.tocsin.sh/mcp` | The remote MCP server (streamable HTTP). |

### Feed filters

All filters on `GET /v1/events` are optional.

- `since=<cursor>`: return events with a cursor above this value. Default 0.
- `ecosystem=<csv>`: OSV ecosystem or runtime name, for example `node,npm,PyPI`. At most 20 values.
- `component=<csv>`: package or runtime name. At most 20 values.
- `min_severity=critical|high|medium|low`
- `exploited=true`: only advisories known to be exploited.
- `limit=1..100`: default 50.
- `order=asc|desc`: default `asc` (oldest first). With `desc`, `next_cursor` is the newest cursor on the page.

An invalid filter answers 400 with `{ "error": "<reason>" }`.

### Check

`GET /v1/check?node=24.22.0&php=8.4.26` checks runtimes only. `POST /v1/check` takes one or more lockfiles as multipart fields, where the field name is the file name (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements.txt`, `go.sum`, `composer.lock`, `Cargo.lock`, `Gemfile.lock`, `pom.xml`, `gradle.lockfile`, `packages.lock.json`, `mix.lock`, `pubspec.lock`), or a JSON body:

```
curl -F "package-lock.json=@package-lock.json" https://tocsin.sh/v1/check
curl -H "Content-Type: application/json" -d '{"dependencies":[{"ecosystem":"npm","name":"left-pad","version":"1.3.0"}],"runtimes":{"node":"24.22.0"}}' https://tocsin.sh/v1/check
```

`pom.xml` lists direct dependencies only. A version from a parent POM, an unknown property or a version range is in `skipped` with its reason; Tocsin never guesses it. A `${property}` value that resolves to more than 256 characters, or a file that needs more than 200 property expansions, is in `skipped` with the reason `unresolved_property`. `gradle.lockfile` is the complete, resolved list.

An OS package list is checked like a runtime: send the release as `alpine` (`3.18`, `v3.18` or `3.18.4`) or `debian` (`12` or `12.5`), and the list text as `os_packages`. The list is the output of `apk list --installed` (Alpine) or `dpkg-query -W -f='${source:Package} ${Version}\n'` (Debian). In JSON, the release goes in `runtimes` and the list at the top level; in multipart, both are form fields. A dependency of an OS list has the ecosystem `Alpine:v3.18` or `Debian:12` and is matched only against advisories of that release. OSV names Alpine and Debian packages by their source package. The Alpine name is the origin from `apk list`. The `dpkg-query` form above gives the source package. `dpkg -l` gives binary names (`libssl3` from `openssl`), and Tocsin has no map from a binary name to its source package. Each `dpkg -l` row is therefore in `skipped` with the reason `binary_package_name` and is never counted as clean. Send the `dpkg-query` form to check a Debian system.

```
curl -F alpine=3.18 --form-string "os_packages=$(apk list --installed)" https://tocsin.sh/v1/check
curl -F debian=12 --form-string "os_packages=$(dpkg-query -W -f='${source:Package} ${Version}\n')" https://tocsin.sh/v1/check
curl -H "Content-Type: application/json" -d '{"runtimes":{"debian":"12"},"os_packages":"openssl 3.0.11-1~deb12u2\n"}' https://tocsin.sh/v1/check
```

A release without `os_packages`, `os_packages` without a release, both `alpine` and `debian`, or an unknown release answers 400 with `{ "error", "field" }`. `GET /v1/check?debian=12` answers 400: a query string has no package list.

Runtime parameters are `node=`, `php=`, `python=`, `go=`, `deno=` and `bun=`. `go=` takes the Go toolchain version as `go version` prints it (`go=1.22.3` or `go=go1.22.3`). It matches the OSV `Go` advisories on the toolchain itself (package `stdlib`, `toolchain` or `cmd/<tool>`) by their OSV range events, and `fixed_in` is the lowest OSV `fixed` version above yours. Those advisories stay `Go` advisories for module matching; the runtime match does not add a second advisory. An affected item for `go=1.22.3` has `dependency` `{ "ecosystem": "go", "name": "go", "version": "1.22.3" }`. The version is echoed as given: `go=go1.22.3` answers `"version": "go1.22.3"`.

The answer is `{ "checked": <int>, "affected": [...], "skipped": [...], "feed_cursor": <int>, "coverage": [...] }`. Each affected item has `dependency`, `advisory_id`, `cve_ids`, `severity`, `exploited`, `fixed_in`, `action` and `url`, critical first, then exploited first. `skipped` lists what could not be checked; it is not a clean result. Send `feed_cursor` as `since=` to `/v1/events` to get every advisory published after the check.

`coverage` has one item per ecosystem of the checked dependencies: `{ "ecosystem": "PyPI", "since": "2016-01-05T00:00:00Z", "complete": true }`. `since` is the oldest `published_at` Tocsin holds for it (null when not known), and `complete` says whether its whole history is loaded. A dependency with no finding in an ecosystem with `complete: false` is in `skipped` as `{ "dependency": {...}, "reason": "partial_coverage", "since": ... }`, never counted as clean. A dependency with a finding stays in `affected`.

A Node.js version on a release line past its end of life (from the [nodejs/Release schedule](https://github.com/nodejs/Release)) is affected by one advisory for that line, severity `high`, `fixed_in` null: the line gets no security fixes, and the action names the lowest supported LTS line.

### Status

`GET /v1/status` answers:

```
{ "sources": [{ "id": "osv", "kind": "osv", "last_run_at": "...", "last_ok_at": "...", "last_error": null, "coverage_since": null }], "cursor": 1234,
  "coverage": [{ "ecosystem": "npm", "since": "2016-01-05T00:00:00Z", "complete": true, "imported": 200000 }] }
```

`cursor` is the newest feed cursor, or 0 when the feed is empty. `coverage_since` is the oldest `published_at` a source holds, null until its history is read in full. `coverage` has one item per enabled OSV ecosystem and per runtime; `imported` is the record count of the latest backfill run of an OSV ecosystem, null for a runtime. The same data is on the page [/status](/status).

## Advisory schema

Each event is one advisory. The schema is at [/schema/advisory.v1.json](/schema/advisory.v1.json).

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The Tocsin id. |
| `cve_ids` | string[] | CVE ids. Can be empty. |
| `ghsa_id` | string | GitHub advisory id, when there is one. |
| `ecosystem` | string | OSV ecosystem (`npm`, `PyPI`, `Go`, `Packagist`, `crates.io`, `RubyGems`, `Maven`, `NuGet`, `Hex`, `Pub`, `Alpine`, `Debian`) or runtime (`node`, `php`, `python`, `go`, `deno`, `bun`). For `Alpine` and `Debian`, `ecosystem_qualifier` holds the release (`Alpine:v3.18`, `Debian:12`); there is one advisory per release. |
| `component` | string | Package or runtime name. |
| `affected` | object[] | Version ranges: `introduced`, `fixed`, `last_affected`. |
| `fixed_versions` | string[] | Versions that fix it. |
| `severity` | object | `label` (`critical`, `high`, `medium`, `low`, `unknown`) and an optional `score`. |
| `exploited` | boolean | Known to be exploited. |
| `epss` | number | EPSS probability, when known. |
| `published_at` | string | ISO 8601 time. |
| `modified_at` | string | ISO 8601 time. |
| `summary` | string | One line from the source. |
| `action` | string | What to do, computed from the data (for example the fixed version). |
| `references` | string[] | Links. |
| `sources` | object[] | Each source record: `source`, `source_id`, `url`. |

## Cursor rule

1. Store `next_cursor`.
2. Send it back as `since=<next_cursor>` on the next call.
3. Repeat while `has_more` is true. When `has_more` is false, you are up to date.

An empty page returns your own `since` as `next_cursor`, so you never lose your place. Each page has a strong `ETag`. Send it back in `If-None-Match`; an unchanged page answers 304.

## Rate limits

Anonymous calls are limited per IP per minute. The limits are settings rows, so they can change without a deploy. The defaults:

- `GET /v1/events`: 60 per minute (`feed.anon_rate_per_minute`).
- `/v1/check`: 20 per minute (`check.anon_rate_per_minute`).
- `POST /v1/check` body: 2 MB (`check.max_body_bytes`). Over the cap the answer is 413.
- `/v1/keys` routes: 5 per minute (`keys.anon_rate_per_minute`). Body: 4 KB (`keys.max_body_bytes`). Over the cap the answer is 413.
- Key link mails (`POST /v1/keys` and `POST /v1/keys/rotate`): 10 per IP per hour (`keys.ip_sends_per_hour`) and 3 per email per hour (`keys.email_sends_per_hour`). `Retry-After` counts to the next clock hour.
- `/v1/watchlists` with an API key: 120 calls per minute per key, shared by every watch list route (`watchlists.key_rate_per_minute`).

Over a limit the answer is 429 with `Retry-After` in seconds.

## API keys and watch lists

A watch list is a saved filter with its own cursor. Poll it and you get only the events you have not seen, so your agent keeps no state.

1. Get a key: `POST /v1/keys` with `{"email": "you@example.com"}`. The answer is `202 {"status": "sent", "expires_in_seconds": 3600}` and holds no key. We mail a link to that address. Open it and press Confirm within 60 minutes (`keys.confirm_ttl_seconds`). Opening the link (`GET /v1/keys/confirm?token=tct_...`) only shows the Confirm page, so a mail scanner that opens it changes nothing. A used, expired or unknown link shows one neutral page (410). The Confirm button sends `POST /v1/keys/confirm` with the token and answers a page with the key. An agent can send the same POST with JSON `{"token": "tct_..."}` and gets `200 {"key": "tcs_...", "key_id", "plan": "free", "email"}`. The key is in that answer only. We store its SHA-256, so we cannot show it again. A token works once; a second POST answers 410. A POST with an `Origin` header of another site answers 403. The 202 is the same for every email, so it does not tell whether an email has a key. If the email already has a key, the link replaces it.
2. Send the key on every watch list call: `Authorization: Bearer tcs_...`. A missing or unknown key answers 401.
3. Create a list: `POST /v1/watchlists` with `{"name", "ecosystems": [], "components": [], "runtimes": {}, "min_severity", "exploited_only"}`. Only `name` is required. The filters combine with AND, like the feed filters. A runtime name in `runtimes` (for example `{"node": "24.0.0"}`) matches that runtime's events; the version is stored, not matched against ranges (use `/v1/check` for that). The answer is 201 with the list. A new list starts at the newest feed cursor, so it returns events published after you made it.
4. Poll it: `GET /v1/watchlists/{id}/events`. The answer has the feed shape, `{"events", "next_cursor", "has_more"}`, oldest first. A 200 with events moves the list's stored cursor to `next_cursor` before the answer is sent. If your client loses that answer, those events are not sent again. To read without moving the cursor, add `?peek=true`. `?limit=1..100` (default 50) sets the page size; repeat while `has_more` is true.
5. `GET /v1/watchlists` lists your lists. `DELETE /v1/watchlists/{id}` deletes one (204).

To replace a key, `POST /v1/keys/rotate` with `{"email"}`. It answers the same 202 and mails a link. Pressing Confirm on it answers a new key with the same `key_id`, plan and watch lists. The old key answers 401 from then on.

Other answers of the key routes: 400 for a bad body or a malformed token, 429 over a send limit or over 5 requests a minute from one IP (`keys.anon_rate_per_minute`), 503 when mail is not set up or the daily mail cap (`mail.daily_send_cap`, 500) is reached, 502 when the mail provider refused the message. None of them depends on whether the email has a key.

Limits come from your plan row. The free plan, the only plan today, allows 25 watch lists and 2,000 components per list. Over a limit the answer is 403 with the limit in the body: `{"error": "watch list limit reached", "max_watchlists": 25}` or `{"error": "component limit reached", "max_components": 2000}`. A body over 1 MB (`watchlists.max_body_bytes`) answers 413. A list that is not yours answers 404.

Input caps on `POST /v1/watchlists`: `name` is at most 100 characters; every other string is at most 200 characters; `ecosystems` holds at most 20 values, each one of `npm`, `PyPI`, `Go`, `Packagist`, `crates.io`, `RubyGems`, `node`, `php`, `python`, `go`, `deno`, `bun`; `runtimes` holds at most 10 entries; the stored filter is at most 64 KB as JSON. A value over a cap answers 400 and the error names the field. `GET /v1/watchlists` answers at most your plan's watch list count (25 on the free plan).

A key that is not used for 365 days is deleted with its watch lists.

### Watch a lockfile

Upload your lockfiles once and get a webhook when a new advisory affects one of your dependencies.

1. Send `POST /v1/watchlists/{id}/lockfile` with the same body as `POST /v1/check`: the lockfiles as multipart (the field name is the file name), or JSON `{"dependencies": [{"ecosystem", "name", "version"}], "runtimes": {...}, "os_packages": "..."}`.
2. The answer is the `/v1/check` result for those dependencies (`checked`, `affected`, `skipped`, `feed_cursor`, `coverage`) plus `watchlist_id` and `dependencies`, the stored count. It is one check: what is affected now is in this answer, and it is not sent again as a webhook.
3. Each upload replaces the stored set of the list. A dependency in an ecosystem the matcher does not support is not stored and comes back in `skipped`. An upload with no supported dependency answers 400 `{"error": "no dependencies to watch"}` and keeps the stored set.
4. After each ingest run (every 10 minutes), Tocsin matches the new and changed advisories against the stored set with the `/v1/check` matcher. On a webhook list, each match is sent once per (list, advisory). The body is the advisory with an `affected` array: the `/v1/check` affected items of your stored dependencies (`dependency`, `advisory_id`, `cve_ids`, `severity`, `exploited`, `fixed_in`, `action`, `url`). The list's filter still applies with AND (`min_severity`, `exploited_only`, `ecosystems`, `components`). A list with a stored set gets matched advisories only, so an empty filter does not send every advisory. A re-upload never sends an advisory again that was already sent. An advisory published more than 30 days before the upload is recorded as `skipped` and not sent, as for filter lists.
5. `GET /v1/watchlists/{id}` answers `dependencies` (the stored count) and `dependencies_uploaded_at`.

The stored set does not change `GET /v1/watchlists/{id}/events`: a polled list still reads its filter. The free plan stores up to 2,000 dependencies per list (the plan row's `max_watch_dependencies`). Over it, the answer is 413 `{"error": "dependency limit reached", "max_watch_dependencies": 2000, "dependencies": <count>}` and nothing is stored. The body cap is the `/v1/check` cap (2 MB, `check.max_body_bytes`). A list that is not yours answers 404. `DELETE /v1/watchlists/{id}` deletes the stored set with the list.

From a project directory, `npx tocsin watch --upload` uploads the lockfiles there to your key's watch list named `default` and makes that list (polled) when it does not exist. Set it to webhook delivery with `PATCH /v1/watchlists/{id}`. `npx tocsin watch` then prints `watching N dependencies, last delivery at ...` before it polls.

## Webhook delivery

A watch list is polled by default. Set it to webhook delivery and Tocsin POSTs each new matching advisory to your URL instead. Webhooks are free.

- On create: `POST /v1/watchlists` with `"delivery": "webhook", "webhook_url": "https://..."` added to the body.
- On an existing list: `PATCH /v1/watchlists/{id}` with `{"delivery": "webhook", "webhook_url": "https://..."}`. `{"delivery": "poll"}` switches back and clears the URL and the secret.
- `webhook_url` must be an `https` URL with no user name or password, at most 2,048 characters. The host must be a name, not an IP address. These hosts are refused: `localhost` and `*.localhost`, `tocsin.sh`, `*.tocsin.sh`, `tocsin.so`, `*.tocsin.so`, `*.workers.dev` and `*.internal`. Bad input answers 400 and the error names the rule.
- The answer that sets `webhook` carries `webhook_secret` (`whsec_` and 64 hex characters). It is in this answer only; no other route returns it. Tocsin stores it encrypted (AES-256-GCM) and decrypts it only to sign a delivery. Each `PATCH` to `webhook` makes a new secret.
- When your plan row has `webhooks` off, setting `webhook` answers 403 `{"error": "webhooks not enabled for this plan"}`. The free plan has it on.

After each ingest run (every 10 minutes), Tocsin finds the advisories above the list's stored cursor that match its filter and sends each one once. Webhook delivery and `GET /v1/watchlists/{id}/events` move the same stored cursor, so an event read by one is not sent by the other. An advisory published more than 30 days before the list was made (backfilled history) is recorded as `skipped` and not sent. The exception is a CISA KEV flag: when KEV marks an old CVE as exploited, the event is sent, so an `exploited_only` list hears about it. Each (list, advisory) pair is sent at most once, so a pair already recorded is not sent again on a later flag. One run queues at most 1,000 new events per list (the settings row `webhooks.enqueue_per_list`); the rest follow in the next run. Only events that are sent count against that cap. A list passes, without a send and in the same run, the advisories it already has a record for (a backfill that gives them new cursors) and backfilled history (recorded as `skipped`). One run reads up to 100,000 matching advisories per list (`webhooks.enqueue_scan_rows`), so a new event behind up to that many such rows still goes out in the same run.

Before each POST, Tocsin checks the URL against the same rules again and resolves the host with DNS over HTTPS. If any A or AAAA answer is a private, loopback, link-local (`169.254.0.0/16`, `fe80::/10`, which holds the cloud metadata address), CGNAT (`100.64.0.0/10`), unique local, multicast or reserved address, the delivery is marked `failed` with `last_error` `blocked_host` and nothing is sent. The IPv6 forms that carry an IPv4 address are blocked too: IPv4-compatible (`::/96`, for example `::127.0.0.1`), 6to4 (`2002::/16`) and IPv4-translated (`::ffff:0:0:0/96`); an IPv4-mapped address (`::ffff:a.b.c.d`) is checked as its IPv4 address. A DNS failure is a failed attempt with `last_error` `dns_failed`, and it is retried. The DNS answers are cached for 60 seconds (the settings row `webhooks.dns_cache_seconds`; `0` resolves at every send). The POST itself resolves the host again, so a DNS answer that changes inside that window is not checked.

### Webhook signature

Each delivery is a POST of the advisory JSON (the same document as `GET /v1/events/{id}`) with these headers:

- `Tocsin-Event-Id`: `<watchlist_id>:<advisory_id>`. It is the same on every attempt of one delivery.
- `Tocsin-Timestamp`: the send time in Unix seconds. Each attempt has its own.
- `Tocsin-Signature: v1=<hex>`: the HMAC-SHA256 of the string `<Tocsin-Timestamp>.<raw body>`, keyed with your webhook secret.

The timestamp is part of the signed string, so a captured body and signature do not verify under a new timestamp.

### Verify a delivery

1. Read the raw body bytes as text. Do not parse and re-serialize the JSON first.
2. Read `Tocsin-Timestamp` and `Tocsin-Signature`. If one is missing, refuse the request.
3. If the timestamp is more than 5 minutes (300 seconds) from your clock, refuse the request. This stops a replay of an old capture.
4. Compute `v1=` and the hex HMAC-SHA256 of `<timestamp>.<raw body>` with your webhook secret.
5. Compare it with `Tocsin-Signature` in constant time. If they differ, refuse the request.
6. Drop a repeat by `Tocsin-Event-Id`.

This function does steps 2 to 5. It uses Web Crypto, so it runs in Node 18 and later, Deno, Bun and Cloudflare Workers. `headers` has lower-case names.

```js
async function verifyTocsinWebhook(secret, headers, rawBody, nowSeconds = Math.floor(Date.now() / 1000)) {
  const ts = headers["tocsin-timestamp"];
  const sig = headers["tocsin-signature"];
  if (!ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Math.abs(nowSeconds - Number(ts)) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${rawBody}`)));
  const expected = "v1=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
```

### Retries

Any 2xx answer is a delivery. Any other answer, a redirect (3xx is not followed), a network error or a 10-second timeout is a failed attempt. A failed attempt is retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours. When the 6th attempt fails, the delivery is marked `failed` and is not sent again. A delivered event is never sent again by a retry, a later ingest run or a backfill that moves the advisory to a new cursor. Wire delivery is at-least-once. If your 2xx answer is lost, or Tocsin sends the POST and then fails to record `delivered`, the event can come again once with the same `Tocsin-Event-Id`: drop a repeat by that id. If the delivery worker itself fails on one event 4 times in a row (the first try and 3 queue retries), the delivery is marked `failed` with `last_error` `dead_letter` and is not sent again.

### Paused delivery

Tocsin counts failed attempts in a row for each webhook list. After 10 (the settings row `webhooks.pause_after_failures`), the list is paused: no new deliveries are queued, and pending deliveries wait as `pending` without using an attempt. Any 2xx answer sets the count back to 0.

`GET /v1/watchlists/{id}` answers the list (`id`, `name`, `filter`, `cursor`, `delivery`, `webhook_url`, `created_at`) and its health: `delivery_status` (`active` or `paused`), `consecutive_failures`, `paused_at`, `last_delivery_at` and `last_delivery_code` (`null` when the last attempt had no HTTP answer).

Fix your endpoint, then send `POST /v1/watchlists/{id}/resume`. It answers the health fields with `delivery_status` `active`. The waiting deliveries are sent within about 10 minutes, and the events that came in while the list was paused follow. A `PATCH` that sets the delivery again also clears a pause. Another key's list answers 404.

### Delivery log

`GET /v1/watchlists/{id}/deliveries` answers `{"deliveries": [...]}`, the 100 newest by feed cursor. Each item has `advisory_id`, `cursor`, `status` (`pending`, `sending`, `delivered`, `failed` or `skipped`), `attempt` (attempts made), `last_code` (the last HTTP status, `null` when there was no answer), `last_error` (`blocked_host`, `dns_failed`, `network`, `secret_unreadable` or `dead_letter` when there was no HTTP status), `next_at` (the next attempt time, only for `pending`) and `delivered_at`. `DELETE /v1/watchlists/{id}` also deletes its deliveries. Skipped rows are deleted after 90 days. Delivered and failed rows are kept while the watch list exists, because they are the record that stops a second send.

## Connect command

```
npx tocsin connect
```

The `tocsin` CLI (Node 20 or later) finds the agent tools on this machine and adds the `tocsin` MCP server (`https://mcp.tocsin.sh/mcp`) to each one: Claude Code (`~/.claude.json`, plus the Tocsin skill), Cursor (`~/.cursor/mcp.json`), Claude Desktop (`claude_desktop_config.json`, through `npx -y mcp-remote`) and Codex (`~/.codex/config.toml`).

Connect also installs the Tocsin skill for Codex (`~/.codex/skills/tocsin/SKILL.md`) and as a Cursor rule (`~/.cursor/rules/tocsin.mdc`).

- `--claude-code`, `--cursor`, `--claude-desktop`, `--codex`: wire only these tools.
- `--dry-run`: print the edits and write nothing.
- `--print`: print the MCP JSON block only.
- `--hook`: with Claude Code, also add a `SessionStart` hook to `~/.claude/settings.json`. The hook runs `npx -y tocsin check --summary`, which prints one line and never blocks the session.
- `--print-agents-md`: print a block for a repo's `AGENTS.md` and write nothing.

A second run changes nothing. Connect never writes a file it cannot parse, never replaces a `tocsin` entry that is already there and never replaces a skill copy that you edited. The same CLI has `npx tocsin check`, `npx tocsin latest` and `npx tocsin watch`.

To add the server by hand in Claude Code:

```
claude mcp add --transport http tocsin https://mcp.tocsin.sh/mcp
```

### Codex

```
npx tocsin connect --codex
```

This adds the MCP server to `~/.codex/config.toml` and the skill to `~/.codex/skills/tocsin/SKILL.md`. Codex also reads `AGENTS.md` in a repo. `npx tocsin connect --print-agents-md` prints this block for it:

```
## Security advisories (Tocsin)

At session start and before a deploy, run `npx tocsin check --json`.
Exit 1: a dependency has an advisory. Read `affected[]` and upgrade to `fixed_in`.
Exit 3: the check failed. Do not report the project as safe.
Docs: https://tocsin.sh/docs
```
