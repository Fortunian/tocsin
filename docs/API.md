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
| `POST /v1/keys` | Issues one API key per email. See [API keys and watch lists](#api-keys-and-watch-lists). |
| `POST /v1/watchlists`, `GET /v1/watchlists`, `DELETE /v1/watchlists/{id}` | Create, list and delete your watch lists. Needs an API key. |
| `PATCH /v1/watchlists/{id}` | Sets how a watch list is delivered: `poll` or `webhook`. Needs an API key. |
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

`GET /v1/check?node=24.22.0&php=8.4.26` checks runtimes only. `POST /v1/check` takes one or more lockfiles as multipart fields, where the field name is the file name (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements.txt`, `go.sum`, `composer.lock`, `Cargo.lock`, `Gemfile.lock`), or a JSON body:

```
curl -F "package-lock.json=@package-lock.json" https://tocsin.sh/v1/check
curl -H "Content-Type: application/json" -d '{"dependencies":[{"ecosystem":"npm","name":"left-pad","version":"1.3.0"}],"runtimes":{"node":"24.22.0"}}' https://tocsin.sh/v1/check
```

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
| `ecosystem` | string | OSV ecosystem (`npm`, `PyPI`, `Go`, `Packagist`, `crates.io`) or runtime (`node`, `php`, `python`, `go`, `deno`, `bun`). |
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
- `POST /v1/keys`: 5 per minute (`keys.anon_rate_per_minute`).

Over a limit the answer is 429 with `Retry-After` in seconds.

## API keys and watch lists

A watch list is a saved filter with its own cursor. Poll it and you get only the events you have not seen, so your agent keeps no state.

1. Get a key: `POST /v1/keys` with `{"email": "you@example.com"}`. The answer is `201 {"key": "tcs_...", "key_id", "plan": "free", "email"}`. The key is in this answer only. We store its SHA-256, so we cannot show it again. A second call for the same email (any case) answers 409 with no key.
2. Send the key on every watch list call: `Authorization: Bearer tcs_...`. A missing or unknown key answers 401.
3. Create a list: `POST /v1/watchlists` with `{"name", "ecosystems": [], "components": [], "runtimes": {}, "min_severity", "exploited_only"}`. Only `name` is required. The filters combine with AND, like the feed filters. A runtime name in `runtimes` (for example `{"node": "24.0.0"}`) matches that runtime's events; the version is stored, not matched against ranges (use `/v1/check` for that). The answer is 201 with the list. A new list starts at the newest feed cursor, so it returns events published after you made it.
4. Poll it: `GET /v1/watchlists/{id}/events`. The answer has the feed shape, `{"events", "next_cursor", "has_more"}`, oldest first. A 200 with events moves the list's stored cursor to `next_cursor` before the answer is sent. If your client loses that answer, those events are not sent again. To read without moving the cursor, add `?peek=true`. `?limit=1..100` (default 50) sets the page size; repeat while `has_more` is true.
5. `GET /v1/watchlists` lists your lists. `DELETE /v1/watchlists/{id}` deletes one (204).

Limits come from your plan row. The free plan, the only plan today, allows 25 watch lists and 2,000 components per list. Over a limit the answer is 403 with the limit in the body: `{"error": "watch list limit reached", "max_watchlists": 25}` or `{"error": "component limit reached", "max_components": 2000}`. A body over 1 MB (`watchlists.max_body_bytes`) answers 413. A list that is not yours answers 404.

A key that is not used for 365 days is deleted with its watch lists.

## Webhook delivery

A watch list is polled by default. Set it to webhook delivery and Tocsin POSTs each new matching advisory to your URL instead. Webhooks are free.

- On create: `POST /v1/watchlists` with `"delivery": "webhook", "webhook_url": "https://..."` added to the body.
- On an existing list: `PATCH /v1/watchlists/{id}` with `{"delivery": "webhook", "webhook_url": "https://..."}`. `{"delivery": "poll"}` switches back and clears the URL and the secret.
- `webhook_url` must be an `https` URL with no user name or password, at most 2,048 characters. Bad input answers 400.
- The answer that sets `webhook` carries `webhook_secret` (`whsec_` and 64 hex characters). It is in this answer only; no other route returns it. Each `PATCH` to `webhook` makes a new secret.
- When your plan row has `webhooks` off, setting `webhook` answers 403 `{"error": "webhooks not enabled for this plan"}`. The free plan has it on.

After each ingest run (every 10 minutes), Tocsin finds the advisories above the list's stored cursor that match its filter and sends each one once. Webhook delivery and `GET /v1/watchlists/{id}/events` move the same stored cursor, so an event read by one is not sent by the other. An advisory published more than 30 days before the list was made (backfilled history) is recorded as `skipped` and not sent. The exception is a CISA KEV flag: when KEV marks an old CVE as exploited, the event is sent, so an `exploited_only` list hears about it. Each (list, advisory) pair is sent at most once, so a pair already recorded is not sent again on a later flag.

### Webhook signature

Each delivery is a POST of the advisory JSON (the same document as `GET /v1/events/{id}`) with these headers:

- `Tocsin-Event-Id`: `<watchlist_id>:<advisory_id>`. It is the same on every attempt of one delivery.
- `Tocsin-Timestamp`: the send time in Unix seconds.
- `Tocsin-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with your webhook secret>`

Compute the HMAC over the raw body bytes and compare it with the header in constant time.

### Retries

Any 2xx answer is a delivery. Any other answer, a redirect (3xx is not followed), a network error or a 10-second timeout is a failed attempt. A failed attempt is retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours. When the 6th attempt fails, the delivery is marked `failed` and is not sent again. A delivered event is never sent again by a retry. If your 2xx answer is lost before Tocsin records it, the event can come again with the same `Tocsin-Event-Id`: drop a repeat by that id.

### Delivery log

`GET /v1/watchlists/{id}/deliveries` answers `{"deliveries": [...]}`, the 100 newest by feed cursor. Each item has `advisory_id`, `cursor`, `status` (`pending`, `sending`, `delivered`, `failed` or `skipped`), `attempt` (attempts made), `last_code` (the last HTTP status, `null` when there was no answer), `next_at` (the next attempt time, only for `pending`) and `delivered_at`. `DELETE /v1/watchlists/{id}` also deletes its deliveries. Delivered, failed and skipped rows are deleted after 90 days.

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
