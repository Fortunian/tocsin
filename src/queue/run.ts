import type { Env } from "../env";

// Stub. The webhooks ticket replaces this body. Returning without an error
// lets the runtime ack the batch.
export async function runQueue(batch: MessageBatch, _env: Env, _ctx: ExecutionContext): Promise<void> {
  console.log(JSON.stringify({ lane: "queue", queue: batch.queue, size: batch.messages.length }));
}
