import { Hono } from "hono";
import { renderRepoBadge, type RepoReport } from "../../site/badge";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";

// GET /badge/<owner>/<repo>.svg (TCS-101): the README badge of one repository,
// from the last report its GitHub Action sent (POST /v1/action/report).
// `?ref=main` or `?ref=refs/heads/main` reads that ref; no ref reads the
// default branch the Action reported. A hit in the edge cache costs 0 DB
// statements; a miss costs 2, run in parallel.
const badgeRepo = new Hono<{ Bindings: Env }>();

// Code fallback only. The live value is settings.badge.cache_seconds.
export const FALLBACK_BADGE_CACHE_SECONDS = 300;

const NAME = /^[A-Za-z0-9_.-]+$/;

// ?1 owner, ?2 repo, ?3 ref. idx_action_reports_ref; the rowid in the index serves ORDER BY id.
export const BADGE_BY_REF_SQL =
  "SELECT affected, min_severity, reported_at FROM action_reports WHERE owner = ?1 AND repo = ?2 AND ref = ?3 ORDER BY id DESC LIMIT 1";
// ?1 owner, ?2 repo. idx_action_reports_default; the rowid in the index serves ORDER BY id.
export const BADGE_DEFAULT_SQL =
  "SELECT affected, min_severity, reported_at FROM action_reports WHERE owner = ?1 AND repo = ?2 AND is_default = 1 ORDER BY id DESC LIMIT 1";

// "main" -> "refs/heads/main"; a value that starts with refs/ is kept; none or empty is the default branch.
function normalizeRef(ref: string | undefined): string | null {
  if (ref === undefined || ref === "") return null;
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
}

async function lookup(db: D1Database, owner: string, repo: string, ref: string | null): Promise<RepoReport | null | "unavailable"> {
  try {
    const stmt = ref === null ? db.prepare(BADGE_DEFAULT_SQL).bind(owner, repo) : db.prepare(BADGE_BY_REF_SQL).bind(owner, repo, ref);
    return await stmt.first<RepoReport>();
  } catch (err) {
    console.error(JSON.stringify({ lane: "badge", step: "lookup", err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
    return "unavailable";
  }
}

badgeRepo.get("/badge/:owner/:file{[^/]+\\.svg}", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("file").slice(0, -".svg".length);
  if (!NAME.test(owner) || !NAME.test(repo)) return jsonUtf8(c, { error: "not found" }, 404);
  const o = owner.toLowerCase();
  const r = repo.toLowerCase();
  const ref = normalizeRef(c.req.query("ref"));

  // The cache key is the canonical URL: lowercase owner/repo, the full ref, no other params.
  const key = new URL(`/badge/${encodeURIComponent(o)}/${encodeURIComponent(r)}.svg`, c.req.url);
  if (ref !== null) key.searchParams.set("ref", ref);
  const cacheKey = new Request(key.toString());
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const [maxAge, report] = await Promise.all([getSettingInt(c.env.DB, "badge.cache_seconds", FALLBACK_BADGE_CACHE_SECONDS), lookup(c.env.DB, o, r, ref)]);
  const headers = { "Content-Type": "image/svg+xml; charset=utf-8" };
  const svg = renderRepoBadge(report);
  // A failed read is not cached, so the next request reads again.
  if (report === "unavailable") return c.body(svg, 200, { ...headers, "Cache-Control": "no-cache" });
  const res = c.body(svg, 200, { ...headers, "Cache-Control": `public, max-age=${maxAge}` });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

export default badgeRepo;
