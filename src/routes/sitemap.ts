import { type Context, Hono } from "hono";
import { SITE_BASE, advisoryPath, cvePath } from "../../site/advisory";
import type { Env } from "../env";

// /sitemap.xml: every advisory page and every CVE page. A sitemap file holds
// at most 50,000 URLs, and each advisory gives up to two (its page and its
// CVE page), so one chunk covers 25,000 feed cursors. Each chunk is one
// bounded range read on idx_advisories_cursor; no read walks the whole table.
export const SITEMAP_MAX_SQL = "SELECT MAX(cursor) AS m FROM advisories";
export const SITEMAP_CHUNK_SQL =
  "SELECT id, cve_primary, modified_at FROM advisories WHERE cursor > ? AND cursor <= ? ORDER BY cursor";
export const CURSORS_PER_CHUNK = 25_000;

const CACHE_CONTROL = "public, max-age=3600";
const XMLNS = "http://www.sitemaps.org/schemas/sitemap/0.9";
const XML_TYPE = "application/xml; charset=utf-8";

type Row = { id: string; cve_primary: string | null; modified_at: string };
type Ctx = Context<{ Bindings: Env }>;

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

async function chunkCount(db: D1Database): Promise<number> {
  const row = await db.prepare(SITEMAP_MAX_SQL).first<{ m: number | null }>();
  return Math.max(1, Math.ceil((row?.m ?? 0) / CURSORS_PER_CHUNK));
}

// One CVE page per CVE in the chunk; a CVE whose advisories span two chunks
// appears in both, which a crawler treats as one URL.
function urlset(rows: Row[]): string {
  const urls: string[] = [];
  const seen = new Set<string>();
  const entry = (path: string, lastmod: string) =>
    `<url><loc>${xmlEscape(SITE_BASE + path)}</loc><lastmod>${xmlEscape(lastmod)}</lastmod></url>`;
  for (const r of rows) {
    urls.push(entry(advisoryPath(r.id), r.modified_at));
    if (r.cve_primary && !seen.has(r.cve_primary)) {
      seen.add(r.cve_primary);
      urls.push(entry(cvePath(r.cve_primary), r.modified_at));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${XMLNS}">\n${urls.join("\n")}\n</urlset>\n`;
}

function sitemapIndex(n: number): string {
  const items = Array.from({ length: n }, (_, i) => `<sitemap><loc>${SITE_BASE}/sitemap-${i + 1}.xml</loc></sitemap>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${XMLNS}">\n${items.join("\n")}\n</sitemapindex>\n`;
}

async function chunk(c: Ctx, n: number): Promise<Response> {
  const lo = (n - 1) * CURSORS_PER_CHUNK;
  const { results } = await c.env.DB.prepare(SITEMAP_CHUNK_SQL).bind(lo, lo + CURSORS_PER_CHUNK).all<Row>();
  return c.body(urlset(results), 200, { "Content-Type": XML_TYPE, "Cache-Control": CACHE_CONTROL });
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
