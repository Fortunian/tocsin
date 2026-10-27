import { Hono } from "hono";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";
import { loadStatus } from "../site/data";
import { loadSocialStatus } from "../social/status";

const status = new Hono<{ Bindings: Env }>();

// The social block (TCS-106) is read in parallel with the sources and coverage.
status.get("/", async (c) => {
  const [data, social] = await Promise.all([loadStatus(c.env.DB, { ledger: true, coverage: true }), loadSocialStatus(c.env.DB, new Date())]);
  return jsonUtf8(c, { ...data, social }, 200, { "Cache-Control": "no-cache" });
});

export default status;
