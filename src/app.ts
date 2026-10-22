import { Hono } from "hono";
import type { Env } from "./env";
import health from "./routes/health";

const app = new Hono<{ Bindings: Env }>();

app.route("/v1/health", health);

export default app;
