import { Hono } from "hono";
import pkg from "../../package.json";
import type { Env } from "../env";

const health = new Hono<{ Bindings: Env }>();

// No DB read: health answers even before migrations run.
health.get("/", (c) => c.json({ ok: true, version: pkg.version }));

export default health;
