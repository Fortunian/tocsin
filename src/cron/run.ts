import type { Env } from "../env";
import { defaultRegistry, runIngesters } from "../ingest/registry";
import type { Ingester } from "../ingest/types";

export async function runCron(
  event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
  registry: Record<string, Ingester> = defaultRegistry,
): Promise<void> {
  console.log(JSON.stringify({ lane: "cron", cron: event.cron, scheduledTime: event.scheduledTime }));
  await runIngesters(env, registry, () => new Date());
}
