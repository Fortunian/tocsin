// TCS-11 round 2, finding 1: SSRF. The webhook URL is checked at registration
// (POST and PATCH answer 400 with the reason) and again at send time, where the
// host is also resolved over DNS over HTTPS (faked here: 0 real calls). A
// blocked host marks the delivery failed with last_error 'blocked_host' and
// makes 0 webhook POSTs.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runQueue } from "../../src/queue/run";
import { call, newKey } from "../routes/keys-helpers.tcs-8";
import { DOH_PREFIX, FakeFetch, FakeQueue, PUBLIC_A, deliveryRow, envWith, fakeBatch, insertDelivery, seedAdvisory, seedList, uid } from "./helpers.tcs-11";

const T0 = new Date("2026-10-23T05:00:00.000Z");

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// [url, the words the 400 error must hold]
const BAD_URLS: Array<[string, string]> = [
  ["http://hooks.example.com/x", "https"],
  ["https://user:pw@hooks.example.com/x", "user name or password"],
  ["https://127.0.0.1/x", "IP address"],
  ["https://10.1.2.3/x", "IP address"],
  ["https://[::1]/x", "IP address"],
  ["https://0x7f000001/x", "IP address"],
  ["https://169.254.169.254/latest/meta-data", "IP address"],
  ["https://localhost/x", "localhost"],
  ["https://api.localhost/x", "localhost"],
  ["https://localhost./x", "localhost"],
  ["https://tocsin.sh/v1/keys", "Tocsin"],
  ["https://api.tocsin.sh/x", "Tocsin"],
  ["https://www.tocsin.so/x", "Tocsin"],
  ["https://my-worker.acct.workers.dev/x", "workers.dev"],
  ["https://metadata.google.internal/x", ".internal"],
];

describe("webhook_url at registration", () => {
  for (const [url, words] of BAD_URLS) {
    it(`POST /v1/watchlists rejects ${url} with 400 naming the reason`, async () => {
      const { key } = await newKey();
      const res = await call("POST", "/v1/watchlists", { key, body: { name: "s", delivery: "webhook", webhook_url: url } });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("webhook_url");
      expect(body.error).toContain(words);
    });
  }

  it("PATCH /v1/watchlists/:id rejects a private host too, and the list stays poll", async () => {
    const { key } = await newKey();
    const created = await call("POST", "/v1/watchlists", { key, body: { name: "s" } });
    const { id } = (await created.json()) as { id: string };
    const res = await call("PATCH", `/v1/watchlists/${id}`, { key, body: { delivery: "webhook", webhook_url: "https://192.168.1.10/hook" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("IP address");
    const row = await env.DB.prepare("SELECT delivery, webhook_url FROM watchlists WHERE id = ?").bind(id).first();
    expect(row).toEqual({ delivery: "poll", webhook_url: null });
  });

  it("accepts a public https host name", async () => {
    const { key } = await newKey();
    const res = await call("POST", "/v1/watchlists", { key, body: { name: "s", delivery: "webhook", webhook_url: "https://hooks.example.com/tocsin" } });
    expect(res.status).toBe(201);
  });
});

async function pairWithUrl(url: string) {
  const list = await seedList({ url });
  const adv = await seedAdvisory();
  await insertDelivery({ watchlist_id: list.id, advisory_id: adv.id, cursor: adv.cursor, status: "pending", next_at: T0.toISOString() });
  return { list, adv };
}

async function consume(list: { id: string }, adv: { id: string }, f: FakeFetch, q = new FakeQueue()) {
  const batch = fakeBatch([{ watchlist_id: list.id, advisory_id: adv.id }]);
  const ctx = createExecutionContext();
  await runQueue(batch, envWith(q), ctx, { fetch: f.fn, now: () => T0 });
  await waitOnExecutionContext(ctx);
  return { msg: batch.messages[0], q };
}

describe("webhook_url at send time", () => {
  // A URL stored before the registration check existed, or written by hand.
  for (const url of ["https://127.0.0.1/x", "https://localhost/x", "https://api.tocsin.sh/x", "https://w.acct.workers.dev/x", "https://db.internal/x", "http://plain.example.com/x"]) {
    it(`a stored ${url} is failed with blocked_host and 0 POSTs`, async () => {
      const { list, adv } = await pairWithUrl(url);
      const f = new FakeFetch([200]);
      const { msg } = await consume(list, adv, f);
      expect(f.calls).toHaveLength(0);
      expect(f.dohCalls).toHaveLength(0);
      const row = await deliveryRow(list.id, adv.id);
      expect(row).toMatchObject({ status: "failed", last_error: "blocked_host" });
      expect(msg.ack).toHaveBeenCalledTimes(1);
    });
  }

  // [label, A answers, AAAA answers] that each make the host blocked.
  const BAD_ANSWERS: Array<[string, string[], string[]]> = [
    ["loopback", ["127.0.0.1"], []],
    ["private 10/8", ["10.0.0.7"], []],
    ["private 172.16/12", ["172.20.1.1"], []],
    ["private 192.168/16", ["192.168.0.4"], []],
    ["link-local and metadata", ["169.254.169.254"], []],
    ["CGNAT", ["100.64.3.2"], []],
    ["multicast", ["224.0.0.251"], []],
    ["unspecified", ["0.0.0.0"], []],
    ["one private answer among public ones", [PUBLIC_A, "10.9.9.9"], []],
    ["IPv6 loopback", [], ["::1"]],
    ["IPv6 link-local", [], ["fe80::1"]],
    ["IPv6 unique local (AWS metadata)", [], ["fd00:ec2::254"]],
    ["IPv6 multicast", [], ["ff02::1"]],
    ["IPv4-mapped IPv6 loopback", [], ["::ffff:127.0.0.1"]],
  ];
  for (const [label, a, aaaa] of BAD_ANSWERS) {
    it(`a host that resolves to ${label} is failed with blocked_host and 0 POSTs`, async () => {
      const host = `${uid("h").toLowerCase()}.example.com`;
      const { list, adv } = await pairWithUrl(`https://${host}/hook`);
      const f = new FakeFetch([200]);
      f.dns[host] = { A: a, AAAA: aaaa };
      await consume(list, adv, f);
      expect(f.calls).toHaveLength(0);
      expect(f.dohCalls.length).toBeGreaterThan(0);
      expect(f.dohCalls.every((u) => u.startsWith(DOH_PREFIX))).toBe(true);
      expect(await deliveryRow(list.id, adv.id)).toMatchObject({ status: "failed", last_error: "blocked_host", attempt: 1 });
    });
  }

  it("a public answer POSTs once, and the DoH answer is cached in KV for the next send", async () => {
    const host = `${uid("h").toLowerCase()}.example.com`;
    const first = await pairWithUrl(`https://${host}/hook`);
    const f = new FakeFetch([200]);
    f.dns[host] = { A: [PUBLIC_A], AAAA: ["2606:4700::6810:84e5"] };
    await consume(first.list, first.adv, f);
    expect(f.calls).toHaveLength(1);
    expect((await deliveryRow(first.list.id, first.adv.id))!.status).toBe("delivered");
    expect(f.dohCalls).toHaveLength(2);

    const second = await pairWithUrl(`https://${host}/other`);
    await consume(second.list, second.adv, f);
    expect(f.calls).toHaveLength(2);
    expect(f.dohCalls).toHaveLength(2);
  });

  it("a DoH NXDOMAIN is a failed attempt with dns_failed and a retry, never a POST", async () => {
    const host = `${uid("h").toLowerCase()}.example.com`;
    const { list, adv } = await pairWithUrl(`https://${host}/hook`);
    const f = new FakeFetch([200]);
    f.dns[host] = { status: 3 };
    const { q } = await consume(list, adv, f);
    expect(f.calls).toHaveLength(0);
    expect(await deliveryRow(list.id, adv.id)).toMatchObject({ status: "pending", attempt: 1, last_error: "dns_failed" });
    expect(q.forList(list.id)).toHaveLength(1);
  });

  it("budget: the DoH check uses only the injected fetch seam, 0 calls to the real fetch", async () => {
    const real = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("real fetch in the PR suite")));
    const host = `${uid("h").toLowerCase()}.example.com`;
    const { list, adv } = await pairWithUrl(`https://${host}/hook`);
    const f = new FakeFetch([200]);
    await consume(list, adv, f);
    expect(real).not.toHaveBeenCalled();
    expect(f.dohCalls).toHaveLength(2);
    expect(f.calls).toHaveLength(1);
  });

  it("a 3xx is still a failed attempt, never followed", async () => {
    const { list, adv } = await pairWithUrl("https://hooks.example.com/redir");
    const f = new FakeFetch([302]);
    await consume(list, adv, f);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].redirect).toBe("manual");
    expect(await deliveryRow(list.id, adv.id)).toMatchObject({ status: "pending", last_code: 302, attempt: 1 });
  });
});
