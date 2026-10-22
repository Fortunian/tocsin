import type { Env } from "../env";

// Stub. The ingest ticket replaces this body.
export async function runCron(event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
  console.log(JSON.stringify({ lane: "cron", cron: event.cron, scheduledTime: event.scheduledTime }));
}
