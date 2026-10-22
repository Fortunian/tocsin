import { Hono } from "hono";
import { renderDocs } from "../../site/docs";
import { renderBadge } from "../../site/freshness";
import { renderLanding } from "../../site/landing";
import { renderStatus } from "../../site/status";
import type { Env } from "../env";
import { freshnessOf, loadHome, loadStatus } from "../site/data";

// The tocsin.sh pages. Only these paths: discovery owns /llms.txt,
// /.well-known/* and /schema/*, and everything else stays a JSON 404.
const site = new Hono<{ Bindings: Env }>();

site.get("/", async (c) => {
  const home = await loadHome(c.env);
  return c.html(renderLanding(home.rows, home.freshness), 200, { "Cache-Control": "public, max-age=60" });
});
site.get("/docs", (c) => c.html(renderDocs(), 200, { "Cache-Control": "public, max-age=60" }));
site.get("/status", async (c) => c.html(renderStatus(await loadStatus(c.env.DB, { ledger: true })), 200, { "Cache-Control": "no-cache" }));

// The README badge (TCS-35). A failed status read draws "degraded" with a short cache.
site.get("/badge/status.svg", async (c) => {
  let svg: string;
  let maxAge = 300;
  try {
    svg = renderBadge(freshnessOf(await loadStatus(c.env.DB)));
  } catch (err) {
    console.error(JSON.stringify({ lane: "site", step: "badge-status", err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
    svg = renderBadge({ updated: null, ok: 0, total: 0 });
    maxAge = 60;
  }
  return c.body(svg, 200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` });
});

export default site;
