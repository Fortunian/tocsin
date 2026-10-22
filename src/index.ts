import app from "./app";
import { runCron } from "./cron/run";
import type { Env } from "./env";
import { runQueue } from "./queue/run";

export default {
  fetch: app.fetch,
  scheduled: (event, env, ctx) => runCron(event, env, ctx),
  queue: (batch, env, ctx) => runQueue(batch, env, ctx),
} satisfies ExportedHandler<Env>;
