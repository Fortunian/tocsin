import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFakeOutbox } from "../../src/mail/fake";
import { call, nextIp, sha256HexOf, uniqueEmail } from "./keys-helpers.tcs-8";

// TCS-83: the three mail send caps (per IP per hour, per email per hour, per
// UTC day) are one atomic reserve in D1 (send_counters), taken before the
// provider call. Every request goes through the production entry point.

const HOUR_MS = 3_600_000;

const SEEDS: Record<string, string> = {
  "keys.ip_sends_per_hour": "10",
  "keys.email_sends_per_hour": "3",
  "mail.daily_send_cap": "500",
  "mail.provider": "mailchannels",
  "mail.from_address": "keys@tocsin.sh",
  "keys.anon_rate_per_minute": "5",
};

async function setSetting(key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

// Each test runs in its own UTC day, so its window keys are its own.
function useDay(day: number, hour = 10): number {
  const t = Date.UTC(2041, 0, day, hour, 0, 5);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
  return t;
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const hourOf = (t: number) => Math.floor(t / HOUR_MS);

async function counter(key: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT n FROM send_counters WHERE window_key = ?").bind(key).first<{ n: number }>();
  return row ? row.n : null;
}

async function putCounter(key: string, n: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO send_counters (window_key, n, created_at) VALUES (?, ?, ?) ON CONFLICT(window_key) DO UPDATE SET n = excluded.n",
  )
    .bind(key, n, new Date().toISOString())
    .run();
}

async function keysFor(t: number, ip: string, email: string): Promise<{ ip: string; em: string; day: string }> {
  return { ip: `ip:${ip}:${hourOf(t)}`, em: `em:${await sha256HexOf(email)}:${hourOf(t)}`, day: `day:${dayOf(t)}` };
}

async function mailCount(emails: string[]): Promise<number> {
  let n = 0;
  for (const e of emails) n += (await readFakeOutbox(env.CURSORS, e)).length;
  return n;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(SEEDS)) await setSetting(k, v);
});

describe("TCS-83 atomic send caps", () => {
  it("C1: 50 parallel POST /v1/keys against a daily cap of 10 send exactly 10 mails", async () => {
    const t = useDay(1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await setSetting("mail.daily_send_cap", "10");
    await setSetting("keys.ip_sends_per_hour", "1000");
    await setSetting("keys.email_sends_per_hour", "1000");
    const emails = Array.from({ length: 50 }, (_, i) => uniqueEmail(`burst-${i}`));
    const res = await Promise.all(emails.map((email) => call("POST", "/v1/keys", { ip: nextIp(), body: { email } })));
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(10);
    expect(statuses.filter((s) => s === 503)).toHaveLength(40);
    expect(await mailCount(emails)).toBe(10);
    expect(await counter(`day:${dayOf(t)}`)).toBe(10);
  });

  it("C2: 50 parallel POST /v1/keys from one IP against a per-IP cap of 10 send exactly 10 mails", async () => {
    const t = useDay(2);
    await setSetting("keys.ip_sends_per_hour", "10");
    await setSetting("keys.anon_rate_per_minute", "1000");
    const ip = nextIp();
    const emails = Array.from({ length: 50 }, (_, i) => uniqueEmail(`ipburst-${i}`));
    const res = await Promise.all(emails.map((email) => call("POST", "/v1/keys", { ip, body: { email } })));
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(40);
    expect(await mailCount(emails)).toBe(10);
    expect(await counter(`ip:${ip}:${hourOf(t)}`)).toBe(10);
    expect(await counter(`day:${dayOf(t)}`)).toBe(10);
  });

  it("C3: the ip row at its cap refuses with 429 and moves neither the email nor the day row", async () => {
    const t = useDay(3);
    const ip = nextIp();
    const email = uniqueEmail("partial");
    const k = await keysFor(t, ip, email);
    await putCounter(k.ip, 10);
    await putCounter(k.day, 5);
    const res = await call("POST", "/v1/keys", { ip, body: { email } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(3600 - 5));
    expect(await counter(k.ip)).toBe(10);
    expect(await counter(k.day)).toBe(5);
    expect(await counter(k.em) ?? 0).toBe(0);
    expect(await mailCount([email])).toBe(0);
  });

  it("C3b: the email row at its cap refuses with 429 and moves neither the ip nor the day row", async () => {
    const t = useDay(4);
    const ip = nextIp();
    const email = uniqueEmail("partial-em");
    const k = await keysFor(t, ip, email);
    await putCounter(k.em, 3);
    await putCounter(k.ip, 2);
    await putCounter(k.day, 7);
    expect((await call("POST", "/v1/keys", { ip, body: { email } })).status).toBe(429);
    expect(await counter(k.em)).toBe(3);
    expect(await counter(k.ip)).toBe(2);
    expect(await counter(k.day)).toBe(7);
  });

  it("C4: rows at cap - 1 send once and move each row by exactly 1; the next request is 429; the next hour sends again", async () => {
    const t = useDay(5);
    const ip = nextIp();
    const email = uniqueEmail("edge");
    const k = await keysFor(t, ip, email);
    await putCounter(k.ip, 9);
    await putCounter(k.em, 1);
    await putCounter(k.day, 20);
    expect((await call("POST", "/v1/keys", { ip, body: { email } })).status).toBe(202);
    expect(await counter(k.ip)).toBe(10);
    expect(await counter(k.em)).toBe(2);
    expect(await counter(k.day)).toBe(21);
    expect((await call("POST", "/v1/keys", { ip, body: { email: uniqueEmail("edge-2") } })).status).toBe(429);
    expect(await counter(k.day)).toBe(21);

    vi.setSystemTime(t + HOUR_MS);
    expect((await call("POST", "/v1/keys", { ip, body: { email: uniqueEmail("edge-3") } })).status).toBe(202);
    expect(await counter(`ip:${ip}:${hourOf(t) + 1}`)).toBe(1);
    expect(await counter(k.day)).toBe(22);
  });

  it("C5: a failed send answers 502 and puts all three rows back", async () => {
    const t = useDay(6);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ip = nextIp();
    const email = uniqueEmail("fail");
    const k = await keysFor(t, ip, email);
    await putCounter(k.ip, 4);
    await putCounter(k.em, 1);
    await putCounter(k.day, 30);
    await setSetting("mail.from_address", "fail@fake.test");
    expect((await call("POST", "/v1/keys", { ip, body: { email } })).status).toBe(502);
    expect(await counter(k.ip)).toBe(4);
    expect(await counter(k.em)).toBe(1);
    expect(await counter(k.day)).toBe(30);
  });

  it("C6: an unknown mail.provider answers 503 and writes no send_counters row", async () => {
    const t = useDay(7);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await setSetting("mail.provider", "nope");
    const ip = nextIp();
    const email = uniqueEmail("noprov");
    const k = await keysFor(t, ip, email);
    expect((await call("POST", "/v1/keys", { ip, body: { email } })).status).toBe(503);
    expect(await counter(k.ip)).toBeNull();
    expect(await counter(k.em)).toBeNull();
    expect(await counter(k.day)).toBeNull();
  });

  it("C7: the send path reads and writes no KV send counter", async () => {
    useDay(8);
    const get = vi.spyOn(env.CURSORS, "get");
    const put = vi.spyOn(env.CURSORS, "put");
    expect((await call("POST", "/v1/keys", { body: { email: uniqueEmail("nokv") } })).status).toBe(202);
    const keys = [...get.mock.calls, ...put.mock.calls].map((c) => String(c[0]));
    expect(keys.filter((k) => k.startsWith("rl:v1:keyssend:") || k.startsWith("mail:sent:"))).toEqual([]);
  });

  it("C7b: a send writes its ip, email and day rows in send_counters", async () => {
    const t = useDay(9);
    const ip = nextIp();
    const email = uniqueEmail("rows");
    const k = await keysFor(t, ip, email);
    expect((await call("POST", "/v1/keys", { ip, body: { email } })).status).toBe(202);
    expect(await counter(k.ip)).toBe(1);
    expect(await counter(k.em)).toBe(1);
    expect(await counter(k.day)).toBe(1);
  });

  it("C8: a cap of 0 refuses every send (429 for ip or email, 503 for day)", async () => {
    useDay(10);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await setSetting("keys.ip_sends_per_hour", "0");
    expect((await call("POST", "/v1/keys", { body: { email: uniqueEmail("zero-ip") } })).status).toBe(429);
    await setSetting("keys.ip_sends_per_hour", "10");
    await setSetting("keys.email_sends_per_hour", "0");
    expect((await call("POST", "/v1/keys", { body: { email: uniqueEmail("zero-em") } })).status).toBe(429);
    await setSetting("keys.email_sends_per_hour", "3");
    await setSetting("mail.daily_send_cap", "0");
    const email = uniqueEmail("zero-day");
    expect((await call("POST", "/v1/keys", { body: { email } })).status).toBe(503);
    expect(await mailCount([email])).toBe(0);
  });
});
