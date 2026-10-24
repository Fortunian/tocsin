import { Hono } from "hono";
import advisorySchema from "../../schema/advisory.v1.json";
import { POST_URL } from "../../site/post";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";

const BASE = "https://tocsin.sh";
const MCP_URL = "https://mcp.tocsin.sh/mcp";

const WELL_KNOWN = {
  schema: `${BASE}/schema/advisory.v1.json`,
  endpoints: {
    events: `${BASE}/v1/events`,
    event: `${BASE}/v1/events/{id}`,
    event_by_cve: `${BASE}/v1/events/cve/{cve}`,
    check: `${BASE}/v1/check`,
    schema: `${BASE}/schema/advisory.v1.json`,
    llms: `${BASE}/llms.txt`,
    mcp: MCP_URL,
  },
  mcp: "https://mcp.tocsin.sh",
  docs: `${BASE}/docs`,
};

const LLMS_TXT = `# Tocsin

Tocsin is one normalized feed of security advisories for runtimes and packages.
Each event is one advisory (schema: ${BASE}/schema/advisory.v1.json).

## Read the feed

curl "${BASE}/v1/events?since=0&min_severity=high"

The answer is { "events": [...], "next_cursor": <int>, "has_more": <bool> }, oldest first.

## Cursor rule

1. Store next_cursor.
2. Send it back as since=<next_cursor> on the next call.
3. Repeat while has_more is true. When has_more is false, you are up to date.
An empty page returns your own since as next_cursor, so you never lose your place.

## Filters (all optional)

- ecosystem=<csv>  OSV ecosystem or runtime name, for example node,npm,PyPI
- component=<csv>  package or runtime name
- min_severity=critical|high|medium|low
- exploited=true   only advisories known to be exploited
- limit=1..100     default 50
- order=desc       newest first; next_cursor is the newest cursor on the page

## Caching and limits

Each page has a strong ETag. Send it back in If-None-Match; an unchanged page answers 304.
Anonymous reads of /v1/events are limited per IP per minute. A 429 carries Retry-After in seconds.

## Check your dependencies

Runtimes only, no body:

curl "${BASE}/v1/check?node=24.22.0&php=8.4.26"

One or more lockfiles, field name = file name (package-lock.json, npm-shrinkwrap.json,
pnpm-lock.yaml, yarn.lock, requirements.txt, go.sum, composer.lock, Cargo.lock, Gemfile.lock,
pom.xml, gradle.lockfile, packages.lock.json, mix.lock, pubspec.lock):

curl -F "package-lock.json=@package-lock.json" ${BASE}/v1/check

Or JSON:

curl -H "Content-Type: application/json" -d '{"dependencies":[{"ecosystem":"npm","name":"left-pad","version":"1.3.0"}],"runtimes":{"node":"24.22.0"}}' ${BASE}/v1/check

An OS package list (Alpine or Debian): the release plus the list text, from apk list --installed
(Alpine) or dpkg-query -W -f='\${source:Package} \${Version}\\n' (Debian, source package names):

curl -F debian=12 --form-string "os_packages=$(dpkg-query -W -f='\${source:Package} \${Version}\\n')" ${BASE}/v1/check

The answer is { "checked": <int>, "affected": [...], "skipped": [...], "feed_cursor": <int> }.
Each affected item has dependency, advisory_id, cve_ids, severity, exploited, fixed_in, action, url,
critical first, then exploited first. skipped lists what could not be checked; it is not a clean result.
Send feed_cursor as since=<feed_cursor> to /v1/events to get every advisory published after the check.
The body cap is 2 MB by default (413 over it). Anonymous checks are limited per IP per minute; a 429 carries Retry-After.

## One advisory

- ${BASE}/v1/events/{id}
- ${BASE}/v1/events/cve/{cve}

As an HTML page (send Accept: application/json to the same URL for the JSON):

- ${BASE}/advisories/{id}
- ${BASE}/cve/{cve}   every advisory that shares the CVE

Every page is listed in ${BASE}/sitemap.xml.

## MCP

Remote MCP server (streamable HTTP): ${MCP_URL}

Claude Code:

claude mcp add --transport http tocsin ${MCP_URL}

Cursor (~/.cursor/mcp.json):

{"mcpServers":{"tocsin":{"url":"${MCP_URL}"}}}

Claude Desktop (claude_desktop_config.json):

{"mcpServers":{"tocsin":{"command":"npx","args":["-y","mcp-remote","${MCP_URL}"]}}}

Tools:

- tocsin_latest   newest advisories; filters ecosystem, min_severity, exploited_only, limit (1..100, default 10)
- tocsin_check    which dependencies are affected; lockfile_name + lockfile_text, and/or runtimes {"node":"24.22.0"}
- tocsin_get      one advisory by Tocsin id or CVE id
- tocsin_watchlist_events  new events on a watch list; needs an API key

Every tool result is { "human": <one line>, "data": <the API answer> }.
tocsin_watchlist_events needs the header Authorization: Bearer <your API key> on the MCP connection.
The other tools need no key.

Discovery: ${BASE}/.well-known/tocsin.json

## Blog

- ${POST_URL}   why Tocsin exists: the October 21 Node and PHP fixes
`;

const discovery = new Hono<{ Bindings: Env }>();

discovery.get("/.well-known/tocsin.json", (c) => jsonUtf8(c, WELL_KNOWN));
discovery.get("/llms.txt", (c) => c.body(LLMS_TXT, 200, { "Content-Type": "text/plain; charset=utf-8" }));
discovery.get("/schema/advisory.v1.json", (c) => jsonUtf8(c, advisorySchema));

export default discovery;
