import { type Context, Hono } from "hono";
import { renderAdvisoryPage, renderCvePage, renderNotFound } from "../../site/advisory";
import type { Env } from "../env";
import { ifNoneMatchHits } from "../feed/etag";
import { jsonUtf8 } from "../lib/http";
import type { Advisory } from "../schema/advisory";

// The human pages for one advisory and one CVE (TCS-34). Each page is one
// indexed read: the advisories primary key, or the advisory_cves primary key
// (every CVE id of an advisory, migration 0010) joined to advisories by id.
export const ADVISORY_BY_ID_SQL = "SELECT doc_json FROM advisories WHERE id = ?";
export const ADVISORIES_BY_CVE_SQL =
  "SELECT a.doc_json FROM advisory_cves c JOIN advisories a ON a.id = c.advisory_id WHERE c.cve = ? ORDER BY a.cursor LIMIT ?";
// A fixed bound on one CVE page, not a tunable: one CVE spans one advisory
// per affected package, and no CVE in the feed comes near this.
export const CVE_PAGE_CAP = 100;

const CACHE_CONTROL = "public, max-age=300";
// Bump when the page markup changes, so cached pages do not answer 304 forever.
const PAGE_VERSION = "1";
const ID_RE = /^tcs_[0-9A-HJKMNP-TV-Z]{26}$/;
const CVE_RE = /^CVE-\d{4}-\d{4,}$/;

type Row = { doc_json: string };
type Ctx = Context<{ Bindings: Env }>;

// JSON only when the client asks for it and does not also take HTML (a browser does).
function wantsJson(c: Ctx): boolean {
  const accept = c.req.header("Accept") ?? "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

// Strong ETag over the representation and each stored doc_json on the page.
// Not modified_at: the EPSS, KEV and NVD enrichments rewrite doc_json and
// leave modified_at alone, and a 304 must never hide an "exploited" flag.
async function pageEtag(kind: string, json: boolean, rows: Row[]): Promise<string> {
  const canonical = JSON.stringify([PAGE_VERSION, kind, json ? "json" : "html", rows.map((r) => r.doc_json)]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex.slice(0, 32)}"`;
}

function notFound(c: Ctx, what: string): Response {
  const headers = { "Cache-Control": "public, max-age=60", Vary: "Accept" };
  if (wantsJson(c)) return jsonUtf8(c, { error: "not found" }, 404, headers);
  return c.html(renderNotFound(what), 404, headers);
}

// The shared answer: 304 on a matching ETag, else JSON or HTML.
async function answer(c: Ctx, kind: string, rows: Row[], alternate: string, view: {
  json: () => unknown;
  html: () => string;
}): Promise<Response> {
  const json = wantsJson(c);
  const etag = await pageEtag(kind, json, rows);
  const headers = {
    ETag: etag,
    "Cache-Control": CACHE_CONTROL,
    Vary: "Accept",
    Link: `<${alternate}>; rel="alternate"; type="application/json"`,
  };
  if (ifNoneMatchHits(c.req.header("If-None-Match"), etag)) return c.body(null, 304, headers);
  if (json) return jsonUtf8(c, view.json(), 200, headers);
  return c.html(view.html(), 200, headers);
}

const advisory = new Hono<{ Bindings: Env }>();

advisory.get("/advisories/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return notFound(c, "Advisory");
  const row = await c.env.DB.prepare(ADVISORY_BY_ID_SQL).bind(id).first<Row>();
  if (!row) return notFound(c, "Advisory");
  const doc = JSON.parse(row.doc_json) as Advisory;
  return answer(c, "advisory", [row], `/v1/events/${encodeURIComponent(id)}`, {
    json: () => doc,
    html: () => renderAdvisoryPage(doc),
  });
});

advisory.get("/cve/:cve", async (c) => {
  const cve = c.req.param("cve").toUpperCase();
  if (!CVE_RE.test(cve)) return notFound(c, "CVE");
  const { results } = await c.env.DB.prepare(ADVISORIES_BY_CVE_SQL).bind(cve, CVE_PAGE_CAP).all<Row>();
  if (results.length === 0) return notFound(c, "CVE");
  const docs = results.map((r) => JSON.parse(r.doc_json) as Advisory);
  return answer(c, `cve:${cve}`, results, `/v1/events/cve/${cve}`, {
    json: () => ({ cve, advisories: docs }),
    html: () => renderCvePage(cve, docs),
  });
});

export default advisory;
