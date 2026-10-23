import type { Env } from "../env";
import { defaultRegistry, runIngesters } from "../ingest/registry";
import type { Ingester } from "../ingest/types";
import { runKeyRetention } from "./retention";

// Monthly (03:17Z on day 1), in wrangler.toml [triggers]. Every other cron
// runs the ingesters.
export const RETENTION_CRON = "17 3 1 * *";

export async function runCron(
  event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
  registry: Record<string, Ingester> = defaultRegistry,
): Promise<void> {
  console.log(JSON.stringify({ lane: "cron", cron: event.cron, scheduledTime: event.scheduledTime }));
  if (event.cron === RETENTION_CRON) {
    await runKeyRetention(env, new Date());
    return;
  }
  await runIngesters(env, registry, () => new Date());
}
