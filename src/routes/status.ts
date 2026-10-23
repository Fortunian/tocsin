import { Hono } from "hono";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";
import { loadStatus } from "../site/data";

const status = new Hono<{ Bindings: Env }>();

status.get("/", async (c) => jsonUtf8(c, await loadStatus(c.env.DB, { ledger: true, coverage: true }), 200, { "Cache-Control": "no-cache" }));

export default status;
