import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { dnsCacheKey } from "../../src/queue/resolve";
import { runQueue } from "../../src/queue/run";
import {
  FakeFetch,
  FakeQueue,
  deliveryRow,
  envWith,
  fakeBatch,
  hmacHex,
  insertDelivery,
  seedAdvisory,
  seedList,
} from "./helpers.tcs-11";

const T0 = new Date("2026-10-23T05:00:00.000Z");

async function pendingPair(listOpts: Parameters<typeof seedList>[0] = {}, nextAt: Date = T0) {
  const list = await seedList(listOpts);
  const adv = await seedAdvisory();
  await insertDelivery({ watchlist_id: list.id, advisory_id: adv.id, cursor: adv.cursor, status: "pending", next_at: nextAt.toISOString() });
  return { list, adv, msg: { watchlist_id: list.id, advisory_id: adv.id } };
}

async function consume(body: unknown, fetcher: FakeFetch, q: FakeQueue, now: Date) {
  const batch = fakeBatch([body]);
  const ctx = createExecutionContext();
  await runQueue(batch, envWith(q), ctx, { fetch: fetcher.fn, now: () => now });
  await waitOnExecutionContext(ctx);
  return batch.messages[0];
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("runQueue webhook consumer", () => {
  it("a 200 marks delivered, and the signature verifies against the received body", async () => {
    const { list, adv, msg } = await pendingPair();
    const f = new FakeFetch([200]);
    const q = new FakeQueue();

    const m = await consume(msg, f, q, T0);

    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    expect(call.url).toBe(list.url);
    expect(call.method).toBe("POST");
    expect(call.redirect).toBe("manual");
    expect(call.body).toBe(adv.doc_json);
    expect(call.headers["tocsin-event-id"]).toBe(`${list.id}:${adv.id}`);
    expect(call.headers["tocsin-timestamp"]).toBe(String(Math.floor(T0.getTime() / 1000)));
    // Round 2 (replay): the MAC covers "<timestamp>.<body>", in the v1= scheme.
    const signed = `${call.headers["tocsin-timestamp"]}.${call.body}`;
    expect(call.headers["tocsin-signature"]).toBe(`v1=${await hmacHex(list.secret, signed)}`);
    expect(call.headers["tocsin-signature"]).not.toBe(`v1=${await hmacHex("whsec_wrong_fixture", signed)}`);
    expect(call.headers["tocsin-signature"]).not.toBe(`v1=${await hmacHex(list.secret, call.body)}`);

    const row = await deliveryRow(list.id, adv.id);
    expect(row).toMatchObject({ status: "delivered", delivered_at: T0.toISOString(), last_code: 200, attempt: 1 });
    expect(m.ack).toHaveBeenCalledTimes(1);
    expect(q.sent).toHaveLength(0);
  });

  it("a 204 is success too", async () => {
    const { list, adv, msg } = await pendingPair();
    await consume(msg, new FakeFetch([204]), new FakeQueue(), T0);
    expect((await deliveryRow(list.id, adv.id))!.status).toBe("delivered");
  });

  it("a 500 schedules next_at 60 seconds later with attempt=1 and one delayed message", async () => {
    const { list, adv, msg } = await pendingPair();
    const q = new FakeQueue();

    await consume(msg, new FakeFetch([500]), q, T0);

    const row = await deliveryRow(list.id, adv.id);
    expect(row).toMatchObject({ status: "pending", attempt: 1, last_code: 500, next_at: new Date(T0.getTime() + 60_000).toISOString(), delivered_at: null });
    expect(q.sent).toEqual([{ body: msg, delaySeconds: 60 }]);
  });

  it("six 500s in a row: backoff 60/300/1800/7200/43200, then the 6th failure marks failed and sends no message", async () => {
    const { list, adv, msg } = await pendingPair();
    const f = new FakeFetch([500]);
    const ladder = [60, 300, 1800, 7200, 43200];
    let now = T0;
    for (let i = 0; i < 5; i++) {
      const q = new FakeQueue();
      await consume(msg, f, q, now);
      const row = (await deliveryRow(list.id, adv.id))!;
      expect(row.status).toBe("pending");
      expect(row.attempt).toBe(i + 1);
      expect(row.next_at).toBe(new Date(now.getTime() + ladder[i] * 1000).toISOString());
      expect(q.sent).toEqual([{ body: msg, delaySeconds: ladder[i] }]);
      now = new Date(row.next_at);
    }
    const q = new FakeQueue();
    await consume(msg, f, q, now);
    const row = (await deliveryRow(list.id, adv.id))!;
    expect(row).toMatchObject({ status: "failed", attempt: 6, last_code: 500 });
    expect(q.sent).toHaveLength(0);
    expect(f.calls).toHaveLength(6);

    // A failed row re-queued makes zero HTTP calls.
    await consume(msg, f, new FakeQueue(), new Date(now.getTime() + 86_400_000));
    expect(f.calls).toHaveLength(6);
  });

  it("a delivered row re-queued by hand makes zero HTTP calls and stays unchanged", async () => {
    const list = await seedList();
    const adv = await seedAdvisory();
    await insertDelivery({ watchlist_id: list.id, advisory_id: adv.id, cursor: adv.cursor, status: "delivered", attempt: 1, last_code: 200, next_at: "2026-10-22T00:00:00.000Z", delivered_at: "2026-10-22T00:00:00.000Z" });
    const before = await deliveryRow(list.id, adv.id);
    const f = new FakeFetch([200]);

    const m = await consume({ watchlist_id: list.id, advisory_id: adv.id }, f, new FakeQueue(), T0);

    expect(f.calls).toHaveLength(0);
    expect(await deliveryRow(list.id, adv.id)).toEqual(before);
    expect(m.ack).toHaveBeenCalledTimes(1);
  });

  it("a pending row whose next_at is in the future (early duplicate) makes zero HTTP calls", async () => {
    const { list, adv, msg } = await pendingPair({}, new Date(T0.getTime() + 60_000));
    const f = new FakeFetch([200]);
    await consume(msg, f, new FakeQueue(), T0);
    expect(f.calls).toHaveLength(0);
    expect((await deliveryRow(list.id, adv.id))!.status).toBe("pending");
  });

  it("a sending row with a live lease makes zero HTTP calls; after the lease it is sent", async () => {
    const list = await seedList();
    const adv = await seedAdvisory();
    await insertDelivery({ watchlist_id: list.id, advisory_id: adv.id, cursor: adv.cursor, status: "sending", next_at: new Date(T0.getTime() + 30_000).toISOString() });
    const f = new FakeFetch([200]);
    const msg = { watchlist_id: list.id, advisory_id: adv.id };

    await consume(msg, f, new FakeQueue(), T0);
    expect(f.calls).toHaveLength(0);

    await consume(msg, f, new FakeQueue(), new Date(T0.getTime() + 31_000));
    expect(f.calls).toHaveLength(1);
    expect((await deliveryRow(list.id, adv.id))!.status).toBe("delivered");
  });

  it("a list switched to poll: zero HTTP calls and the row is failed", async () => {
    const { list, adv, msg } = await pendingPair();
    await env.DB.prepare("UPDATE watchlists SET delivery = 'poll', webhook_url = NULL, webhook_secret = NULL WHERE id = ?").bind(list.id).run();
    const f = new FakeFetch([200]);

    await consume(msg, f, new FakeQueue(), T0);

    expect(f.calls).toHaveLength(0);
    expect((await deliveryRow(list.id, adv.id))!).toMatchObject({ status: "failed", last_code: null });
  });

  it("a 302 counts as a failure", async () => {
    const { list, adv, msg } = await pendingPair();
    await consume(msg, new FakeFetch([302]), new FakeQueue(), T0);
    expect((await deliveryRow(list.id, adv.id))!).toMatchObject({ status: "pending", attempt: 1, last_code: 302 });
  });

  it("a network error counts as a failure with last_code NULL", async () => {
    const { list, adv, msg } = await pendingPair();
    const q = new FakeQueue();
    await consume(msg, new FakeFetch(["throw"]), q, T0);
    expect((await deliveryRow(list.id, adv.id))!).toMatchObject({ status: "pending", attempt: 1, last_code: null });
    expect(q.sent).toHaveLength(1);
  });

  it("a malformed message body is acked with zero HTTP calls", async () => {
    const f = new FakeFetch([200]);
    const m = await consume({ nope: 1 }, f, new FakeQueue(), T0);
    expect(f.calls).toHaveLength(0);
    expect(m.ack).toHaveBeenCalledTimes(1);
  });
});

describe("worker.queue (production entry)", () => {
  it("delivers through the src/index.ts queue handler with the global fetch", async () => {
    const { list, adv, msg } = await pendingPair({}, new Date(Date.now() - 1000));
    await env.CURSORS.delete(dnsCacheKey(new URL(list.url).hostname));
    const f = new FakeFetch([200]);
    vi.spyOn(globalThis, "fetch").mockImplementation(f.fn);
    const batch = fakeBatch([msg]);
    const ctx = createExecutionContext();

    await worker.queue(batch, envWith(new FakeQueue()), ctx);
    await waitOnExecutionContext(ctx);

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(list.url);
    expect((await deliveryRow(list.id, adv.id))!.status).toBe("delivered");
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    // Round 2: the send-time DoH check goes through the same fetch seam (faked, 0 real calls).
    expect(f.dohCalls).toHaveLength(2);
  });
});
