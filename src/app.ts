import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { jsonUtf8 } from "./lib/http";
import check from "./routes/check";
import discovery from "./routes/discovery";
import events from "./routes/events";
import health from "./routes/health";

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], exposeHeaders: ["ETag", "Retry-After"] }),
);

app.route("/v1/health", health);
app.route("/v1/events", events);
app.route("/v1/check", check);
app.route("/", discovery);

app.notFound((c) => jsonUtf8(c, { error: "not found" }, 404));
app.onError((err, c) => {
  console.error(JSON.stringify({ lane: "http", err: `${err.name}: ${err.message}` }));
  return jsonUtf8(c, { error: "internal error" }, 500);
});

export default app;
