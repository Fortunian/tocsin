import { Hono } from "hono";
import { renderDocs } from "../../site/docs";
import { renderLanding } from "../../site/landing";
import { renderStatus } from "../../site/status";
import type { Env } from "../env";
import { loadLatest, loadStatus } from "../site/data";

// The tocsin.sh pages. Only these three paths: discovery owns /llms.txt,
// /.well-known/* and /schema/*, and everything else stays a JSON 404.
const site = new Hono<{ Bindings: Env }>();

site.get("/", async (c) => c.html(renderLanding(await loadLatest(c.env)), 200, { "Cache-Control": "public, max-age=60" }));
site.get("/docs", (c) => c.html(renderDocs(), 200, { "Cache-Control": "public, max-age=60" }));
site.get("/status", async (c) => c.html(renderStatus(await loadStatus(c.env.DB)), 200, { "Cache-Control": "no-cache" }));

export default site;
