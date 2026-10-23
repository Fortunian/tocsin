import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { jsonUtf8 } from "./lib/http";
import advisory from "./routes/advisory";
import check from "./routes/check";
import discovery from "./routes/discovery";
import events from "./routes/events";
import health from "./routes/health";
import site from "./routes/site";
import sitemap from "./routes/sitemap";
import status from "./routes/status";
import { soRedirect } from "./site/redirect";

const app = new Hono<{ Bindings: Env }>();

// First: tocsin.so answers 301 before any other middleware runs.
app.use("*", soRedirect);

app.use(
  "*",
  cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], exposeHeaders: ["ETag", "Retry-After"] }),
);

app.route("/v1/health", health);
app.route("/v1/events", events);
app.route("/v1/check", check);
app.route("/v1/status", status);
app.route("/", discovery);
app.route("/", site);
app.route("/", advisory);
app.route("/", sitemap);

app.notFound((c) => jsonUtf8(c, { error: "not found" }, 404));
app.onError((err, c) => {
  console.error(JSON.stringify({ lane: "http", err: `${err.name}: ${err.message}` }));
  return jsonUtf8(c, { error: "internal error" }, 500);
});

export default app;
