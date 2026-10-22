# Tocsin API

Base URL: `https://tocsin.sh`. Every answer is JSON in UTF-8 unless this page says otherwise. Reads need no account and no key.

## Endpoints

| Method and path | What it answers |
|---|---|
| `GET /v1/health` | `{ "ok": true, "version": "<x.y.z>" }` when the worker is up. |
| `GET /v1/events` | One page of the feed: `{ "events": [...], "next_cursor": <int>, "has_more": <bool> }`. |
| `GET /v1/events/{id}` | One advisory by its Tocsin id. 404 when it does not exist. |
| `GET /v1/events/cve/{cve}` | The earliest advisory for a CVE id (`CVE-YYYY-NNNN`). 400 for a malformed id, 404 when none. |
| `GET /advisories/{id}` | One advisory as an HTML page. HTML is the default: no `Accept` header, `*/*` and any `Accept` that names `text/html` get HTML. An `Accept` that names `application/json` (any q-value) and not `text/html` gets the advisory JSON. ETag with 304, `Cache-Control: public, max-age=300`. 404 when it does not exist. |
| `GET /cve/{cve}` | Every advisory that carries a CVE id (any of its `cve_ids`), as one HTML page. `Accept: application/json` returns `{ "cve", "advisories": [...] }`. 404 when none. |
| `GET /sitemap.xml` | Every advisory page and every CVE page, with no `lastmod`. Past one file (50,000 URLs at most) it is an index of `/sitemap-{n}.xml` files. |
| `GET /v1/check` | Which runtimes are affected, from query parameters such as `?node=24.22.0&php=8.4.26`. |
| `POST /v1/check` | Which dependencies are affected, from lockfiles (multipart) or JSON. |
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

The answer is `{ "checked": <int>, "affected": [...], "skipped": [...], "feed_cursor": <int> }`. Each affected item has `dependency`, `advisory_id`, `cve_ids`, `severity`, `exploited`, `fixed_in`, `action` and `url`, critical first, then exploited first. `skipped` lists what could not be checked; it is not a clean result. Send `feed_cursor` as `since=` to `/v1/events` to get every advisory published after the check.

### Status

`GET /v1/status` answers:

```
{ "sources": [{ "id": "osv", "kind": "osv", "last_run_at": "...", "last_ok_at": "...", "last_error": null }], "cursor": 1234 }
```

`cursor` is the newest feed cursor, or 0 when the feed is empty. The same data is on the page [/status](/status).

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

Over a limit the answer is 429 with `Retry-After` in seconds.

## Webhook signature

Not live yet. Watch lists, API keys and webhook delivery are planned and not in the API today. The planned format: each delivery is a POST of the advisory JSON with these headers:

- `Tocsin-Event-Id`: the event id.
- `Tocsin-Timestamp`: the send time.
- `Tocsin-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with your webhook secret>`

Compute the HMAC over the raw body bytes and compare it with the header in constant time.

## Connect command

```
npx tocsin connect
```

The `tocsin` CLI (Node 20 or later) finds the agent tools on this machine and adds the `tocsin` MCP server (`https://mcp.tocsin.sh/mcp`) to each one: Claude Code (`~/.claude.json`, plus the Tocsin skill), Cursor (`~/.cursor/mcp.json`), Claude Desktop (`claude_desktop_config.json`, through `npx -y mcp-remote`) and Codex (`~/.codex/config.toml`).

- `--claude-code`, `--cursor`, `--claude-desktop`, `--codex`: wire only these tools.
- `--dry-run`: print the edits and write nothing.
- `--print`: print the MCP JSON block only.

A second run changes nothing. Connect never writes a file it cannot parse and never replaces a `tocsin` entry that is already there. The same CLI has `npx tocsin check`, `npx tocsin latest` and `npx tocsin watch`.

To add the server by hand in Claude Code:

```
claude mcp add --transport http tocsin https://mcp.tocsin.sh/mcp
```
