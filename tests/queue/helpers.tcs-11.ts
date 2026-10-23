import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { Env } from "../../src/env";
import type { WatchlistFilter } from "../../src/watchlists/filter";
import { docFor } from "../routes/seed.tcs-3";

// Seed helpers, a recording fake queue and a recording fake fetch for the
// TCS-11 suites. Every id is unique (randomUUID), so tests in one file never
// share rows; assertions filter by the ids a test made.

export interface QueueMessageRecord {
  body: { watchlist_id: string; advisory_id: string };
  delaySeconds?: number;
}

export class FakeQueue {
  sent: QueueMessageRecord[] = [];
  fail = false;
  async send(body: unknown, opts?: { delaySeconds?: number }): Promise<void> {
    if (this.fail) throw new Error("fake queue send failed");
    this.sent.push({ body: body as QueueMessageRecord["body"], delaySeconds: opts?.delaySeconds });
  }
  async sendBatch(msgs: Iterable<{ body: unknown; delaySeconds?: number }>): Promise<void> {
    if (this.fail) throw new Error("fake queue sendBatch failed");
    for (const m of msgs) this.sent.push({ body: m.body as QueueMessageRecord["body"], delaySeconds: m.delaySeconds });
  }
  forList(watchlistId: string): QueueMessageRecord[] {
    return this.sent.filter((m) => m.body.watchlist_id === watchlistId);
  }
}

export function envWith(queue: FakeQueue): Env {
  return { ...(env as unknown as Env), DELIVERIES: queue as unknown as Queue };
}

let cursorSeq = 5_000_000;
export function nextCursor(): number {
  cursorSeq += 1;
  return cursorSeq;
}

export function uid(tag: string): string {
  return `${tag}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function seedKey(): Promise<string> {
  const id = uid("key11");
  const ts = new Date().toISOString();
  await env.DB.prepare("INSERT INTO api_keys (id, key_hash, plan, email, created_at, last_used_at) VALUES (?, ?, 'free', ?, ?, ?)")
    .bind(id, `hash-fixture-${id}`, `${id}@example.test`, ts, ts)
    .run();
  return id;
}

export interface ListOpts {
  keyId?: string;
  delivery?: "poll" | "webhook";
  filter?: Partial<WatchlistFilter>;
  cursor?: number;
  url?: string | null;
  secret?: string | null;
  createdAt?: string;
}

export async function seedList(o: ListOpts = {}): Promise<{ id: string; keyId: string; secret: string; url: string }> {
  const id = uid("wl11");
  const keyId = o.keyId ?? (await seedKey());
  const filter: WatchlistFilter = { ecosystems: [], components: [], runtimes: {}, min_severity: null, exploited_only: false, ...o.filter };
  const delivery = o.delivery ?? "webhook";
  const url = o.url === undefined ? `https://hooks.example.test/${id}` : o.url;
  const secret = o.secret === undefined ? `whsec_fixture_${id}` : o.secret;
  await env.DB.prepare(
    `INSERT INTO watchlists (id, key_id, name, filter_json, cursor, delivery, webhook_url, webhook_secret, created_at)
     VALUES (?, ?, 'tcs11', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, keyId, JSON.stringify(filter), o.cursor ?? 0, delivery, delivery === "webhook" ? url : null, delivery === "webhook" ? secret : null, o.createdAt ?? "2026-10-20T00:00:00.000Z")
    .run();
  return { id, keyId, secret: secret ?? "", url: url ?? "" };
}

export interface AdvOpts {
  ecosystem?: string;
  component?: string;
  cursor?: number;
  publishedAt?: string;
  cve?: string;
}

export async function seedAdvisory(o: AdvOpts = {}): Promise<{ id: string; cursor: number; doc_json: string }> {
  const id = "tcs_" + crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();
  const cursor = o.cursor ?? nextCursor();
  const doc = docFor({ id, cursor, ecosystem: o.ecosystem ?? "npm", component: o.component ?? "left-pad", cve: o.cve });
  doc.published_at = o.publishedAt ?? "2026-10-21T00:00:00Z";
  const doc_json = JSON.stringify(doc);
  await env.DB.prepare(
    `INSERT INTO advisories (id, cve_primary, ecosystem, component, severity_label, exploited, published_at, modified_at, doc_json, cursor)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  )
    .bind(id, o.cve ?? null, doc.ecosystem, doc.component, doc.severity.label, doc.published_at, doc.modified_at, doc_json, cursor)
    .run();
  return { id, cursor, doc_json };
}

export interface DeliveryRow {
  watchlist_id: string;
  advisory_id: string;
  cursor: number;
  attempt: number;
  status: string;
  last_code: number | null;
  next_at: string;
  delivered_at: string | null;
}

export async function deliveriesOf(watchlistId: string): Promise<DeliveryRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM deliveries WHERE watchlist_id = ? ORDER BY cursor").bind(watchlistId).all<DeliveryRow>();
  return results;
}

export async function deliveryRow(watchlistId: string, advisoryId: string): Promise<DeliveryRow | null> {
  return env.DB.prepare("SELECT * FROM deliveries WHERE watchlist_id = ? AND advisory_id = ?").bind(watchlistId, advisoryId).first<DeliveryRow>();
}

export async function insertDelivery(r: Partial<DeliveryRow> & { watchlist_id: string; advisory_id: string; cursor: number }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO deliveries (watchlist_id, advisory_id, cursor, attempt, status, last_code, next_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(r.watchlist_id, r.advisory_id, r.cursor, r.attempt ?? 0, r.status ?? "pending", r.last_code ?? null, r.next_at ?? "2026-10-20T00:00:00.000Z", r.delivered_at ?? null)
    .run();
}

export async function setKnob(k: string, v: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v).run();
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: string | undefined;
}

// One faked DNS over HTTPS answer set for a host. status is the DoH Status
// field (0 = NOERROR, 3 = NXDOMAIN); "throw" fails the DoH call itself.
export interface DnsFixture {
  A?: string[];
  AAAA?: string[];
  status?: number | "throw";
}
export const DOH_PREFIX = "https://cloudflare-dns.com/dns-query";
// A public address (TEST-NET would be blocked as reserved, so this is a
// documentation-free public range). Any host without a fixture resolves here.
export const PUBLIC_A = "93.184.215.14";

// Answers each webhook call with the next scripted status (the last one
// repeats). A status of "throw" rejects like a network error. DoH calls are
// answered from `dns` and recorded in `dohCalls`, never in `calls`, so a
// test counts webhook POSTs alone. 0 network calls.
export class FakeFetch {
  calls: FetchCall[] = [];
  dohCalls: string[] = [];
  dns: Record<string, DnsFixture> = {};
  constructor(private script: Array<number | "throw"> = [200]) {}
  private doh(url: string): Response {
    this.dohCalls.push(url);
    const q = new URL(url).searchParams;
    const name = q.get("name") ?? "";
    const type = q.get("type") === "AAAA" ? "AAAA" : "A";
    const fx = this.dns[name] ?? { A: [PUBLIC_A] };
    if (fx.status === "throw") throw new TypeError("fake DoH network error");
    const data = fx[type] ?? [];
    const Answer = data.map((d) => ({ name, type: type === "A" ? 1 : 28, TTL: 300, data: d }));
    return new Response(JSON.stringify({ Status: fx.status ?? 0, Answer }), { headers: { "Content-Type": "application/dns-json" } });
  }
  fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(input).startsWith(DOH_PREFIX)) return this.doh(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    this.calls.push({ url: String(input), method: init?.method ?? "GET", headers, body: String(init?.body ?? ""), redirect: init?.redirect });
    const next = this.script.length > 1 ? this.script.shift()! : this.script[0];
    if (next === "throw") throw new TypeError("fake network error");
    return new Response(next === 204 || next === 304 ? null : "ok", { status: next, headers: next >= 300 && next < 400 ? { Location: "https://elsewhere.example.test/" } : {} });
  };
}

export interface FakeMessage {
  id: string;
  timestamp: Date;
  body: unknown;
  attempts: number;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

export function fakeBatch(bodies: unknown[]): MessageBatch & { messages: FakeMessage[] } {
  const messages: FakeMessage[] = bodies.map((body) => ({ id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
  return { queue: "deliveries", messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch & { messages: FakeMessage[] };
}

export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
