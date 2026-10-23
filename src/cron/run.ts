import type { Env } from "../env";
import { defaultRegistry, runIngesters } from "../ingest/registry";
import type { Ingester } from "../ingest/types";
import { enqueueDependencyMatches } from "../queue/dependency-match";
import { enqueueDeliveries, sweepDeliveries } from "../queue/enqueue";
import { runDeliveryRetention } from "./deliveries-retention";
import { reencryptWebhookSecrets } from "./reencrypt-secrets";
import { runKeyRetention } from "./retention";

// Monthly (03:17Z on day 1), in wrangler.toml [triggers]. Every other cron
// runs the ingesters.
export const RETENTION_CRON = "17 3 1 * *";
// Daily (04:41Z), in wrangler.toml [triggers]: deliveries retention only.
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
    await runDeliveryRetention(env, new Date());
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
  // Lists with a stored dependency set (TCS-37).
  try {
    await enqueueDependencyMatches(env, new Date());
  } catch (err) {
    console.error(JSON.stringify({ lane: "depmatch", err: errText(err) }));
  }
  try {
    await sweepDeliveries(env, new Date());
  } catch (err) {
    console.error(JSON.stringify({ lane: "sweep", err: errText(err) }));
  }
  // Moves plaintext webhook secrets under WEBHOOK_KEK (TCS-82). After the
  // move it reads 0 rows from an empty partial index.
  try {
    await reencryptWebhookSecrets(env);
  } catch (err) {
    console.error(JSON.stringify({ lane: "reencrypt", err: errText(err) }));
  }
}
