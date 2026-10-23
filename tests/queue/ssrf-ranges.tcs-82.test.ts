// TCS-82 items 5 and 8 (comment 6373816984). Item 5: the send-time DNS check
// also blocks the IPv6 forms that carry an IPv4 address: IPv4-compatible
// (::/96), 6to4 (2002::/16) and IPv4-translated (::ffff:0:0:0/96). Item 8: a
// shorter DNS cache at send time: webhooks.dns_cache_seconds is 60 after the
// migrations, and 0 means no cache (a DoH query at every send).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { dnsCacheKey } from "../../src/queue/resolve";
import { runQueue } from "../../src/queue/run";
import { isBlockedAddress } from "../../src/watchlists/webhook-url";
import { FakeFetch, FakeQueue, deliveryRow, envWith, fakeBatch, insertDelivery, seedAdvisory, seedList, setKnob } from "./helpers.tcs-11";

const T0 = new Date("2026-10-23T05:00:00.000Z");

const BLOCKED: string[] = [
  "::7f00:1", // IPv4-compatible 127.0.0.1
  "::127.0.0.1",
  "::8.8.8.8", // the whole ::/96 is deprecated, public or not
  "::a00:1",
  "2002:7f00:1::", // 6to4 of 127.0.0.1
  "2002:0808:0808::", // 6to4 of a public address: the whole 2002::/16
  "2002:c0a8:101::1",
  "::ffff:0:7f00:1", // IPv4-translated
  "::ffff:0:127.0.0.1",
  "::ffff:0:8.8.8.8",
];
const ALLOWED: string[] = [
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "::ffff:8.8.8.8", // IPv4-mapped of a public address keeps the embedded check
  "2003::1", // next to 2002::/16
  "2001:2002::1",
  "::1:0:0:1", // not in ::/96
  "8.8.8.8",
];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("isBlockedAddress: IPv6 forms that carry an IPv4 address", () => {
  for (const ip of BLOCKED) {
    it(`blocks ${ip}`, () => {
      expect(isBlockedAddress(ip)).toBe(true);
    });
  }
  for (const ip of ALLOWED) {
    it(`allows ${ip}`, () => {
      expect(isBlockedAddress(ip)).toBe(false);
    });
  }
  it("still blocks ::ffff:127.0.0.1 and ::1 (unchanged)", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
  });
});

// A KV that records each put's options.
function recordingKv(): { kv: KVNamespace; puts: Array<{ key: string; opts: unknown }>; gets: string[] } {
  const puts: Array<{ key: string; opts: unknown }> = [];
  const gets: string[] = [];
  const kv = new Proxy(env.CURSORS, {
    get(t, p) {
      if (p === "put") return (key: string, value: string, opts?: unknown) => (puts.push({ key, opts }), t.put(key, value, opts as KVNamespacePutOptions));
      if (p === "get") return (key: string, ...rest: unknown[]) => (gets.push(key), (t.get as (...a: unknown[]) => unknown)(key, ...rest));
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { kv, puts, gets };
}

async function sendOnce(listUrl: string, f: FakeFetch, e: Env) {
  const list = await seedList({ url: listUrl });
  const adv = await seedAdvisory();
  await insertDelivery({ watchlist_id: list.id, advisory_id: adv.id, cursor: adv.cursor, status: "pending", next_at: T0.toISOString() });
  const ctx = createExecutionContext();
  await runQueue(fakeBatch([{ watchlist_id: list.id, advisory_id: adv.id }]), e, ctx, { fetch: f.fn, now: () => T0 });
  await waitOnExecutionContext(ctx);
  return { list, adv };
}

describe("send time", () => {
  it("a DoH AAAA answer of 2002:7f00:1:: fails the delivery as blocked_host with 0 POSTs", async () => {
    const host = `sixtofour-${crypto.randomUUID()}.example.test`;
    const f = new FakeFetch([200]);
    f.dns[host] = { A: ["93.184.215.14"], AAAA: ["2002:7f00:1::"] };
    const { list, adv } = await sendOnce(`https://${host}/hook`, f, envWith(new FakeQueue()));
    expect(f.calls).toHaveLength(0);
    expect(await deliveryRow(list.id, adv.id)).toMatchObject({ status: "failed" });
    const r = await env.DB.prepare("SELECT last_error FROM deliveries WHERE watchlist_id = ? AND advisory_id = ?").bind(list.id, adv.id).first<{ last_error: string }>();
    expect(r!.last_error).toBe("blocked_host");
  });
});

describe("DNS cache at send time", () => {
  it("dns_cache_seconds is 60 after the migrations, and the KV key is written with expirationTtl 60", async () => {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'webhooks.dns_cache_seconds'").first<{ value: string }>();
    expect(row!.value).toBe("60");
    const host = `cache60-${crypto.randomUUID()}.example.test`;
    const rec = recordingKv();
    const f = new FakeFetch([200]);
    await sendOnce(`https://${host}/hook`, f, { ...envWith(new FakeQueue()), CURSORS: rec.kv });
    expect(f.calls).toHaveLength(1);
    expect(rec.puts.filter((p) => p.key === dnsCacheKey(host)).map((p) => p.opts)).toEqual([{ expirationTtl: 60 }]);

    // A second send within the cache window makes no DoH query.
    const before = f.dohCalls.length;
    await sendOnce(`https://${host}/hook`, f, { ...envWith(new FakeQueue()), CURSORS: rec.kv });
    expect(f.dohCalls.length).toBe(before);
    expect(f.calls).toHaveLength(2);
  });

  it("dns_cache_seconds 0: two sends make two DoH lookups and no KV read or write", async () => {
    const was = await env.DB.prepare("SELECT value FROM settings WHERE key = 'webhooks.dns_cache_seconds'").first<{ value: string }>();
    await setKnob("webhooks.dns_cache_seconds", "0");
    const host = `nocache-${crypto.randomUUID()}.example.test`;
    const rec = recordingKv();
    const f = new FakeFetch([200]);
    try {
      await sendOnce(`https://${host}/hook`, f, { ...envWith(new FakeQueue()), CURSORS: rec.kv });
      await sendOnce(`https://${host}/hook`, f, { ...envWith(new FakeQueue()), CURSORS: rec.kv });
    } finally {
      await setKnob("webhooks.dns_cache_seconds", was!.value);
    }

    expect(f.calls).toHaveLength(2);
    // Each lookup asks A and AAAA.
    expect(f.dohCalls.filter((u) => u.includes(encodeURIComponent(host)))).toHaveLength(4);
    expect(rec.puts.filter((p) => p.key === dnsCacheKey(host))).toEqual([]);
    expect(rec.gets.filter((k) => k === dnsCacheKey(host))).toEqual([]);
    expect(await env.CURSORS.get(dnsCacheKey(host))).toBeNull();
  });
});
