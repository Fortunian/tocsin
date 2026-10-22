import { Hono } from "hono";
import type { Env } from "../env";
import { eventsEtag, ifNoneMatchHits } from "../feed/etag";
import { buildEventsQuery, parseEventsFilters } from "../feed/query";
import { jsonUtf8 } from "../lib/http";
import { rateLimit } from "../middleware/ratelimit";

const CACHE_CONTROL = "public, max-age=60";
const CVE_RE = /^CVE-\d{4}-\d{4,}$/;

const events = new Hono<{ Bindings: Env }>();

events.use("*", rateLimit);

events.get("/", async (c) => {
  const parsed = parseEventsFilters(new URL(c.req.url));
  if (!parsed.ok) return jsonUtf8(c, { error: parsed.error }, 400);
  const f = parsed.filters;

  const { sql, params } = buildEventsQuery(f);
  const { results } = await c.env.DB.prepare(sql)
    .bind(...params)
    .all<{ cursor: number; doc_json: string }>();

  const has_more = results.length > f.limit;
  const page = has_more ? results.slice(0, f.limit) : results;
  // The newest cursor on the page: the last row asc, the first row desc.
  const newest = f.order === "desc" ? page[0] : page[page.length - 1];
  const next_cursor = newest ? newest.cursor : f.since;

  const etag = await eventsEtag(f, next_cursor, has_more);
  const headers = { ETag: etag, "Cache-Control": CACHE_CONTROL };
  if (ifNoneMatchHits(c.req.header("If-None-Match"), etag)) {
    return c.body(null, 304, headers);
  }
  return jsonUtf8(c, { events: page.map((r) => JSON.parse(r.doc_json)), next_cursor, has_more }, 200, headers);
});

// Registered before /:id. Several advisories can share a CVE (one per
// package); this answers the earliest one by cursor.
events.get("/cve/:cve", async (c) => {
  const cve = c.req.param("cve").toUpperCase();
  if (!CVE_RE.test(cve)) return jsonUtf8(c, { error: "not a CVE id (CVE-YYYY-NNNN)" }, 400);
  const row = await c.env.DB.prepare(
    "SELECT doc_json FROM advisories WHERE cve_primary = ? ORDER BY cursor LIMIT 1",
  )
    .bind(cve)
    .first<{ doc_json: string }>();
  if (!row) return jsonUtf8(c, { error: "not found" }, 404);
  return jsonUtf8(c, JSON.parse(row.doc_json));
});

events.get("/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT doc_json FROM advisories WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ doc_json: string }>();
  if (!row) return jsonUtf8(c, { error: "not found" }, 404);
  return jsonUtf8(c, JSON.parse(row.doc_json));
});

export default events;
