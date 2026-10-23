// TCS-11 round 2, finding 4: a dead endpoint pauses its watch list. After
// settings.webhooks.pause_after_failures (default 10) failed attempts in a
// row, the list is paused: enqueue skips it, the consumer claims none of its
// rows (pending rows stay pending, no attempt burned), the sweep sends none.
// GET /v1/watchlists/:id shows the health fields and POST /:id/resume clears
// the pause. A success resets the counter.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueDeliveries, sweepDeliveries } from "../../src/queue/enqueue";
import { runQueue } from "../../src/queue/run";
import { call, newKey } from "../routes/keys-helpers.tcs-8";
import { FakeFetch, FakeQueue, deliveriesOf, deliveryRow, envWith, fakeBatch, insertDelivery, seedAdvisory, seedList, setKnob, uid } from "./helpers.tcs-11";

const T0 = new Date("2026-10-23T05:00:00.000Z");
const LATER = new Date("2026-10-24T05:00:00.000Z");

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setKnob("webhooks.pause_after_failures", "10");
});

interface Health {
  consecutive_failures: number;
  paused_at: string | null;
  last_delivery_at: string | null;
  last_delivery_code: number | null;
}
async function health(id: string): Promise<Health> {
  const r = await env.DB.prepare("SELECT consecutive_failures, paused_at, last_delivery_at, last_delivery_code FROM watchlists WHERE id = ?").bind(id).first<Health>();
  if (!r) throw new Error(`no list ${id}`);
  return r;
}

async function consume(pairs: Array<{ watchlist_id: string; advisory_id: string }>, f: FakeFetch, now: Date, q = new FakeQueue()) {
  const batch = fakeBatch(pairs);
  const ctx = createExecutionContext();
  await runQueue(batch, envWith(q), ctx, { fetch: f.fn, now: () => now });
  await waitOnExecutionContext(ctx);
  return q;
}

async function pendingFor(listId: string, n: number, nextAt = T0): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const adv = await seedAdvisory();
    await insertDelivery({ watchlist_id: listId, advisory_id: adv.id, cursor: adv.cursor, status: "pending", next_at: nextAt.toISOString() });
    ids.push(adv.id);
  }
  return ids;
}

// One failed attempt per advisory, one message at a time.
async function failEach(listId: string, advIds: string[], f: FakeFetch, now = T0) {
  for (const a of advIds) await consume([{ watchlist_id: listId, advisory_id: a }], f, now);
}

describe("delivery health", () => {
  it("10 failed attempts pause the list; the 11th advisory makes 0 POSTs and stays pending", async () => {
    const comp = uid("comp");
    const list = await seedList({ filter: { components: [comp] } });
    const advs = await pendingFor(list.id, 10);
    const f = new FakeFetch([503]);

    await failEach(list.id, advs.slice(0, 9), f);
    expect(await health(list.id)).toMatchObject({ consecutive_failures: 9, paused_at: null, last_delivery_code: 503, last_delivery_at: T0.toISOString() });
    await failEach(list.id, advs.slice(9), f);
    expect(f.calls).toHaveLength(10);
    const h = await health(list.id);
    expect(h.consecutive_failures).toBe(10);
    expect(h.paused_at).toBe(T0.toISOString());

    // The 11th advisory, already queued as a pending row: no claim, no POST.
    const [eleventh] = await pendingFor(list.id, 1);
    await consume([{ watchlist_id: list.id, advisory_id: eleventh }], f, LATER);
    expect(f.calls).toHaveLength(10);
    expect(await deliveryRow(list.id, eleventh)).toMatchObject({ status: "pending", attempt: 0 });

    // A due retry of an earlier row: no claim, attempt not burned.
    await consume([{ watchlist_id: list.id, advisory_id: advs[0] }], f, LATER);
    expect(f.calls).toHaveLength(10);
    expect(await deliveryRow(list.id, advs[0])).toMatchObject({ status: "pending", attempt: 1 });

    // A new matching advisory: enqueue skips the paused list (no row, no message).
    const fresh = await seedAdvisory({ component: comp });
    const q = new FakeQueue();
    await enqueueDeliveries(envWith(q), LATER);
    expect(await deliveryRow(list.id, fresh.id)).toBeNull();
    expect(q.forList(list.id)).toHaveLength(0);

    // The sweep re-sends none of the paused list's rows.
    const sq = new FakeQueue();
    await sweepDeliveries(envWith(sq), LATER);
    expect(sq.forList(list.id)).toHaveLength(0);
  });

  it("a success resets the counter and records the code", async () => {
    const list = await seedList();
    const advs = await pendingFor(list.id, 4);
    await failEach(list.id, advs.slice(0, 3), new FakeFetch([500]));
    expect((await health(list.id)).consecutive_failures).toBe(3);
    await failEach(list.id, advs.slice(3), new FakeFetch([200]));
    expect(await health(list.id)).toMatchObject({ consecutive_failures: 0, paused_at: null, last_delivery_code: 200, last_delivery_at: T0.toISOString() });
  });

  it("reads the threshold from settings.webhooks.pause_after_failures", async () => {
    await setKnob("webhooks.pause_after_failures", "3");
    const list = await seedList();
    const advs = await pendingFor(list.id, 3);
    await failEach(list.id, advs, new FakeFetch(["throw"]));
    expect(await health(list.id)).toMatchObject({ consecutive_failures: 3, paused_at: T0.toISOString(), last_delivery_code: null });
  });
});

async function webhookList(key: string, comp: string): Promise<string> {
  const res = await call("POST", "/v1/watchlists", { key, body: { name: "h", components: [comp], delivery: "webhook", webhook_url: "https://hooks.example.com/h" } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("GET /v1/watchlists/:id and POST /v1/watchlists/:id/resume", () => {
  it("GET shows the health fields, active then paused", async () => {
    await setKnob("webhooks.pause_after_failures", "2");
    const { key } = await newKey();
    const id = await webhookList(key, uid("comp"));

    const fresh = await call("GET", `/v1/watchlists/${id}`, { key });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("Cache-Control")).toBe("no-store");
    const b0 = (await fresh.json()) as Record<string, unknown>;
    expect(b0).toMatchObject({ id, delivery: "webhook", webhook_url: "https://hooks.example.com/h", delivery_status: "active", consecutive_failures: 0, paused_at: null, last_delivery_at: null, last_delivery_code: null });
    expect(b0).not.toHaveProperty("webhook_secret");

    await failEach(id, await pendingFor(id, 2), new FakeFetch([500]));
    const b1 = (await (await call("GET", `/v1/watchlists/${id}`, { key })).json()) as Record<string, unknown>;
    expect(b1).toMatchObject({ delivery_status: "paused", consecutive_failures: 2, paused_at: T0.toISOString(), last_delivery_at: T0.toISOString(), last_delivery_code: 500 });
  });

  it("GET of another key's list answers 404", async () => {
    const owner = await newKey();
    const other = await newKey();
    const id = await webhookList(owner.key, uid("comp"));
    expect((await call("GET", `/v1/watchlists/${id}`, { key: other.key })).status).toBe(404);
  });

  it("resume clears the pause for the owner only; the list then delivers and enqueues again", async () => {
    await setKnob("webhooks.pause_after_failures", "1");
    const owner = await newKey();
    const other = await newKey();
    const comp = uid("comp");
    const id = await webhookList(owner.key, comp);
    const [first] = await pendingFor(id, 1);
    await failEach(id, [first], new FakeFetch([500]));
    expect((await health(id)).paused_at).not.toBeNull();
    const waiting = await seedAdvisory({ component: comp });

    expect((await call("POST", `/v1/watchlists/${id}/resume`, { key: other.key })).status).toBe(404);
    expect((await health(id)).paused_at).not.toBeNull();

    const res = await call("POST", `/v1/watchlists/${id}/resume`, { key: owner.key });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, delivery_status: "active", consecutive_failures: 0, paused_at: null });

    // The advisory that came in while paused is enqueued now (the cursor did not move).
    const q = new FakeQueue();
    await enqueueDeliveries(envWith(q), LATER);
    expect(q.forList(id).map((m) => m.body.advisory_id)).toEqual([waiting.id]);

    const f = new FakeFetch([200]);
    await consume([{ watchlist_id: id, advisory_id: first }, { watchlist_id: id, advisory_id: waiting.id }], f, LATER);
    expect(f.calls).toHaveLength(2);
    expect((await deliveriesOf(id)).map((r) => r.status)).toEqual(["delivered", "delivered"]);
  });

  it("resume of an unknown list answers 404", async () => {
    const { key } = await newKey();
    expect((await call("POST", "/v1/watchlists/wl_nope/resume", { key })).status).toBe(404);
  });
});
