import { type Context, Hono } from "hono";
import { SITE_BASE, advisoryPath, cvePath } from "../../site/advisory";
import { POST_PATH } from "../../site/post";
import type { Env } from "../env";

// /sitemap.xml: every advisory page and every CVE page (each CVE id of an
// advisory, from advisory_cves). A sitemap file holds at most 50,000 URLs.
// One chunk covers 20,000 feed cursors: one page each, plus their CVE pages
// (about one per advisory). Each chunk is one bounded range read on
// idx_advisories_cursor joined on idx_advisory_cves_advisory_id; no read
// walks the whole table. There is no <lastmod>: no column records when an
// enrichment (EPSS, KEV, NVD) last changed a page, and a wrong date is worse
// than none.
export const SITEMAP_MAX_SQL = "SELECT MAX(cursor) AS m FROM advisories";
export const SITEMAP_CHUNK_SQL =
  "SELECT a.id, c.cve FROM advisories a LEFT JOIN advisory_cves c ON c.advisory_id = a.id WHERE a.cursor > ? AND a.cursor <= ? ORDER BY a.cursor";
export const CURSORS_PER_CHUNK = 20_000;
export const MAX_URLS = 50_000;

const CACHE_CONTROL = "public, max-age=3600";
const XMLNS = "http://www.sitemaps.org/schemas/sitemap/0.9";
const XML_TYPE = "application/xml; charset=utf-8";

type Row = { id: string; cve: string | null };
type Ctx = Context<{ Bindings: Env }>;

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

async function chunkCount(db: D1Database): Promise<number> {
  const row = await db.prepare(SITEMAP_MAX_SQL).first<{ m: number | null }>();
  return Math.max(1, Math.ceil((row?.m ?? 0) / CURSORS_PER_CHUNK));
}

// The static site pages that chunk 1 lists ahead of the advisories (TCS-14).
export const STATIC_PATHS = [POST_PATH];

// Static pages (chunk 1 only), then advisory pages, then one URL per CVE in the
// chunk. A CVE whose advisories span two chunks appears in both, which a
// crawler treats as one URL. Past MAX_URLS the rest of the CVE URLs are dropped
// and logged.
function urlset(rows: Row[], extra: string[] = []): string {
  const pages = new Set<string>(extra);
  const cves = new Set<string>();
  for (const r of rows) {
    pages.add(advisoryPath(r.id));
    if (r.cve) cves.add(cvePath(r.cve));
  }
  const all = [...pages, ...cves];
  if (all.length > MAX_URLS) {
    console.error(JSON.stringify({ lane: "sitemap", urls: all.length, kept: MAX_URLS }));
  }
  const urls = all.slice(0, MAX_URLS).map((path) => `<url><loc>${xmlEscape(SITE_BASE + path)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${XMLNS}">\n${urls.join("\n")}\n</urlset>\n`;
}

function sitemapIndex(n: number): string {
  const items = Array.from({ length: n }, (_, i) => `<sitemap><loc>${SITE_BASE}/sitemap-${i + 1}.xml</loc></sitemap>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${XMLNS}">\n${items.join("\n")}\n</sitemapindex>\n`;
}

async function chunk(c: Ctx, n: number): Promise<Response> {
  const lo = (n - 1) * CURSORS_PER_CHUNK;
  const { results } = await c.env.DB.prepare(SITEMAP_CHUNK_SQL).bind(lo, lo + CURSORS_PER_CHUNK).all<Row>();
  return c.body(urlset(results, n === 1 ? STATIC_PATHS : []), 200, { "Content-Type": XML_TYPE, "Cache-Control": CACHE_CONTROL });
}

const sitemap = new Hono<{ Bindings: Env }>();

// One chunk: the urlset itself. More: an index of /sitemap-<n>.xml.
sitemap.get("/sitemap.xml", async (c) => {
  const n = await chunkCount(c.env.DB);
  if (n === 1) return chunk(c, 1);
  return c.body(sitemapIndex(n), 200, { "Content-Type": XML_TYPE, "Cache-Control": CACHE_CONTROL });
});

sitemap.get("/:file{sitemap-[0-9]+\\.xml}", async (c) => {
  const n = Number(c.req.param("file").slice("sitemap-".length, -".xml".length));
  if (!Number.isSafeInteger(n) || n < 1 || n > (await chunkCount(c.env.DB))) {
    return c.body("not found\n", 404, { "Content-Type": "text/plain; charset=utf-8" });
  }
  return chunk(c, n);
});

export default sitemap;
