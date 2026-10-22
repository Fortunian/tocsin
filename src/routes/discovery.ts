import { Hono } from "hono";
import advisorySchema from "../../schema/advisory.v1.json";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";

const BASE = "https://tocsin.sh";

const WELL_KNOWN = {
  schema: `${BASE}/schema/advisory.v1.json`,
  endpoints: {
    events: `${BASE}/v1/events`,
    event: `${BASE}/v1/events/{id}`,
    event_by_cve: `${BASE}/v1/events/cve/{cve}`,
    schema: `${BASE}/schema/advisory.v1.json`,
    llms: `${BASE}/llms.txt`,
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

## Caching and limits

Each page has a strong ETag. Send it back in If-None-Match; an unchanged page answers 304.
Anonymous reads of /v1/events are limited per IP per minute. A 429 carries Retry-After in seconds.

## One advisory

- ${BASE}/v1/events/{id}
- ${BASE}/v1/events/cve/{cve}

Discovery: ${BASE}/.well-known/tocsin.json
`;

const discovery = new Hono<{ Bindings: Env }>();

discovery.get("/.well-known/tocsin.json", (c) => jsonUtf8(c, WELL_KNOWN));
discovery.get("/llms.txt", (c) => c.body(LLMS_TXT, 200, { "Content-Type": "text/plain; charset=utf-8" }));
discovery.get("/schema/advisory.v1.json", (c) => jsonUtf8(c, advisorySchema));

export default discovery;
