import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { jsonUtf8 } from "./lib/http";
import { authIpRateLimit } from "./middleware/ratelimit";
import actionReport from "./routes/action-report";
import advisory from "./routes/advisory";
import badgeRepo from "./routes/badge-repo";
import check from "./routes/check";
import discovery from "./routes/discovery";
import events from "./routes/events";
import health from "./routes/health";
import internalImport from "./routes/internal-import";
import keys from "./routes/keys";
import site from "./routes/site";
import sitemap from "./routes/sitemap";
import status from "./routes/status";
import watchlists from "./routes/watchlists";
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
// Bearer-gated write path of the OSV backfill (TCS-32). Not for browsers: CORS stays GET/HEAD/OPTIONS.
app.route("/v1/internal/import", internalImport);
// GitHub OIDC-gated write path of the per-repo badge (TCS-101). Not for browsers either.
app.route("/v1/action/report", actionReport);
// Per-IP gate before any key work (TCS-66). "/x/*" also matches "/x".
app.use("/v1/keys/*", authIpRateLimit);
app.use("/v1/watchlists/*", authIpRateLimit);
app.route("/v1/keys", keys);
app.route("/v1/watchlists", watchlists);
app.route("/", discovery);
app.route("/", site);
app.route("/", badgeRepo);
app.route("/", advisory);
app.route("/", sitemap);

app.notFound((c) => jsonUtf8(c, { error: "not found" }, 404));
app.onError((err, c) => {
  console.error(JSON.stringify({ lane: "http", err: `${err.name}: ${err.message}` }));
  return jsonUtf8(c, { error: "internal error" }, 500);
});

export default app;
