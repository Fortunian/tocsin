// TCS-82 items 3 and 4: queue consumer settings with a dead-letter queue, the
// DLQ consumer that turns a dead message into a failed row with the reason,
// the at-least-once note in docs/API.md, and the timeout/lease invariant.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import apiMd from "../../docs/API.md?raw";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { DLQ_QUEUE, LOAD_SQL, runQueue } from "../../src/queue/run";
import wranglerToml from "../../wrangler.toml?raw";
import { FakeFetch, FakeQueue, deliveryRow, envWith, fakeBatch, insertDelivery, seedAdvisory, seedList, setKnob } from "./helpers.tcs-11";

const T0 = new Date("2026-10-23T05:00:00.000Z");

// The key = value lines of each [[queues.consumers]] table in wrangler.toml.
function consumers(toml: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  let cur: Record<string, string> | null = null;
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) {
      cur = line === "[[queues.consumers]]" ? {} : null;
      if (cur) out.push(cur);
      continue;
    }
    const m = /^([a-z_]+)\s*=\s*(.+)$/.exec(line);
    if (cur && m) cur[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

function dlqBatch(bodies: unknown[]) {
  const b = fakeBatch(bodies);
  (b as { queue: string }).queue = DLQ_QUEUE;
  return b;
}

async function rowIn(status: string) {
  const list = await seedList();
  const adv = await seedAdvisory();
  await insertDelivery({
    watchlist_id: list.id,
    advisory_id: adv.id,
    cursor: adv.cursor,
    status,
    last_code: status === "delivered" ? 200 : null,
    next_at: T0.toISOString(),
    delivered_at: status === "delivered" ? T0.toISOString() : null,
  });
  return { list, adv, msg: { watchlist_id: list.id, advisory_id: adv.id } };
}

async function lastError(watchlistId: string, advisoryId: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT last_error FROM deliveries WHERE watchlist_id = ? AND advisory_id = ?").bind(watchlistId, advisoryId).first<{ last_error: string | null }>();
  return r!.last_error;
}

// An env whose D1 throws on the consumer's LOAD_SQL read: a consumer throw
// after the claim, the case a DLQ exists for.
function envLoadThrows(): Env {
  const e = envWith(new FakeQueue());
  const db = new Proxy(e.DB, {
    get(t, p) {
      if (p === "prepare") {
        return (sql: string) => {
          if (sql === LOAD_SQL) throw new Error("fixture D1 failure");
          return t.prepare(sql);
        };
      }
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ...e, DB: db };
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setKnob("webhooks.timeout_ms", "10000");
  await setKnob("webhooks.lease_seconds", "60");
});

describe("wrangler.toml consumer settings", () => {
  it("the deliveries consumer has max_batch_size, max_retries, max_concurrency and dead_letter_queue deliveries-dlq; a deliveries-dlq consumer exists", () => {
    const all = consumers(wranglerToml);
    const main = all.find((c) => c.queue === "deliveries");
    expect(main).toBeDefined();
    expect(main).toMatchObject({ max_batch_size: "10", max_retries: "3", max_concurrency: "5", dead_letter_queue: DLQ_QUEUE });
    expect(DLQ_QUEUE).toBe("deliveries-dlq");
    const dlq = all.find((c) => c.queue === DLQ_QUEUE);
    expect(dlq).toBeDefined();
    expect(dlq!.dead_letter_queue).toBeUndefined();
  });
});

describe("the dead-letter consumer", () => {
  it("a dead-lettered message of a sending row: failed with last_error dead_letter, acked, logged as an error", async () => {
    const { list, adv, msg } = await rowIn("sending");
    const batch = dlqBatch([msg]);
    const ctx = createExecutionContext();
    await runQueue(batch, envWith(new FakeQueue()), ctx, { fetch: new FakeFetch().fn, now: () => T0 });
    await waitOnExecutionContext(ctx);

    expect(await deliveryRow(list.id, adv.id)).toMatchObject({ status: "failed" });
    expect(await lastError(list.id, adv.id)).toBe("dead_letter");
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((s: string) => s.includes('"lane":"dlq"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ lane: "dlq", watchlist_id: list.id, advisory_id: adv.id, changed: 1 });
  });

  it("a delivered row and a skipped row are never changed by the DLQ; a pending row is failed", async () => {
    const delivered = await rowIn("delivered");
    const skipped = await rowIn("skipped");
    const pending = await rowIn("pending");
    const f = new FakeFetch();
    const batch = dlqBatch([delivered.msg, skipped.msg, pending.msg, { bad: true }]);
    const ctx = createExecutionContext();
    await runQueue(batch, envWith(new FakeQueue()), ctx, { fetch: f.fn, now: () => T0 });
    await waitOnExecutionContext(ctx);

    expect(await deliveryRow(delivered.list.id, delivered.adv.id)).toMatchObject({ status: "delivered", last_code: 200 });
    expect(await lastError(delivered.list.id, delivered.adv.id)).toBeNull();
    expect(await deliveryRow(skipped.list.id, skipped.adv.id)).toMatchObject({ status: "skipped" });
    expect(await deliveryRow(pending.list.id, pending.adv.id)).toMatchObject({ status: "failed" });
    expect(await lastError(pending.list.id, pending.adv.id)).toBe("dead_letter");
    for (const m of batch.messages) expect(m.ack).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(0);
  });

  it("a consumer throw is retried by the queue, and the dead-lettered message lands as a failed row with the reason (production queue handler)", async () => {
    const { list, adv, msg } = await rowIn("pending");
    const e = envLoadThrows();

    // The deliveries consumer throws after its claim: the message is retried.
    const first = fakeBatch([msg]);
    const ctx1 = createExecutionContext();
    await worker.queue(first as unknown as MessageBatch, e, ctx1);
    await waitOnExecutionContext(ctx1);
    expect(first.messages[0].retry).toHaveBeenCalledTimes(1);
    expect(first.messages[0].ack).not.toHaveBeenCalled();
    expect(await deliveryRow(list.id, adv.id)).toMatchObject({ status: "sending" });

    // After max_retries the queue moves it to deliveries-dlq.
    const dead = dlqBatch([msg]);
    const ctx2 = createExecutionContext();
    await worker.queue(dead as unknown as MessageBatch, envWith(new FakeQueue()), ctx2);
    await waitOnExecutionContext(ctx2);
    expect(dead.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(await deliveryRow(list.id, adv.id)).toMatchObject({ status: "failed" });
    expect(await lastError(list.id, adv.id)).toBe("dead_letter");
  });
});

describe("timeout/lease invariant", () => {
  it("timeout_ms 60000 with lease_seconds 60 is refused: 0 fetch calls, row stays pending, message acked, one error log", async () => {
    await setKnob("webhooks.timeout_ms", "60000");
    await setKnob("webhooks.lease_seconds", "60");
    const { list, adv, msg } = await rowIn("pending");
    const f = new FakeFetch([200]);
    const batch = fakeBatch([msg]);
    const ctx = createExecutionContext();
    await runQueue(batch, envWith(new FakeQueue()), ctx, { fetch: f.fn, now: () => T0 });
    await waitOnExecutionContext(ctx);

    expect(f.calls).toHaveLength(0);
    expect(f.dohCalls).toHaveLength(0);
    expect(await deliveryRow(list.id, adv.id)).toMatchObject({ status: "pending", attempt: 0 });
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((s: string) => s.includes("invariant"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("webhooks.timeout_ms");
  });

  it("timeout_ms 59999 with lease_seconds 60 delivers", async () => {
    await setKnob("webhooks.timeout_ms", "59999");
    await setKnob("webhooks.lease_seconds", "60");
    const { list, adv, msg } = await rowIn("pending");
    const f = new FakeFetch([200]);
    const ctx = createExecutionContext();
    await runQueue(fakeBatch([msg]), envWith(new FakeQueue()), ctx, { fetch: f.fn, now: () => T0 });
    await waitOnExecutionContext(ctx);
    expect(f.calls).toHaveLength(1);
    expect(await deliveryRow(list.id, adv.id)).toMatchObject({ status: "delivered" });
  });
});

describe("docs", () => {
  it("docs/API.md Retries states at-least-once delivery, Tocsin-Event-Id dedup and the dead_letter end", () => {
    const at = apiMd.indexOf("### Retries");
    expect(at).toBeGreaterThan(-1);
    const end = apiMd.indexOf("\n### ", at + 1);
    const retries = apiMd.slice(at, end === -1 ? undefined : end);
    expect(retries).toContain("at-least-once");
    expect(retries).toContain("Tocsin-Event-Id");
    expect(retries).toContain("dead_letter");
  });
});
