import type { Env } from "../env";
import { defaultRegistry, runIngesters } from "../ingest/registry";
import type { Ingester } from "../ingest/types";
import { enqueueDeliveries, sweepDeliveries } from "../queue/enqueue";
import { runDeliveryRetention } from "./deliveries-retention";
import { runKeyRetention } from "./retention";
import { runSendCounterRetention } from "./send-counters-retention";

// Monthly (03:17Z on day 1), in wrangler.toml [triggers]. Every other cron
// runs the ingesters.
export const RETENTION_CRON = "17 3 1 * *";
// Daily (04:41Z), in wrangler.toml [triggers]: deliveries and send_counters retention.
export const DELIVERY_RETENTION_CRON = "41 4 * * *";

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

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
  if (event.cron === DELIVERY_RETENTION_CRON) {
    // Both jobs run even when one throws; the first fault still fails the cron.
    const now = new Date();
    const results = await Promise.allSettled([runDeliveryRetention(env, now), runSendCounterRetention(env, now)]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    return;
  }
  await runIngesters(env, registry, () => new Date());
  // Webhook delivery after each ingest run. The ingest outcome is already
  // recorded per source, so a throw here is logged and never fails the cron.
  try {
    await enqueueDeliveries(env, new Date());
  } catch (err) {
    console.error(JSON.stringify({ lane: "enqueue", err: errText(err) }));
  }
  try {
    await sweepDeliveries(env, new Date());
  } catch (err) {
    console.error(JSON.stringify({ lane: "sweep", err: errText(err) }));
  }
}
