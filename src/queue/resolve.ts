import { isBlockedAddress } from "../watchlists/webhook-url";

// Send-time DNS check of a webhook host (TCS-11). The host is resolved with
// DNS over HTTPS through the consumer's fetch seam, and the POST is refused
// when any A or AAAA answer is a blocked address. The answers are cached in
// KV (CURSORS) for settings.webhooks.dns_cache_seconds.
export const DOH_URL = "https://cloudflare-dns.com/dns-query";
// Code fallback only. The live value is settings.webhooks.dns_cache_seconds.
export const FALLBACK_DNS_CACHE_SECONDS = 600;
// KV refuses an expirationTtl under 60 seconds. A platform limit, not a knob.
const KV_MIN_TTL = 60;

export const dnsCacheKey = (host: string) => `webhooks:dns:${host}`;

export type HostVerdict = { ok: true } | { ok: false; reason: "blocked_host" | "dns_failed"; detail: string };

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

interface DohAnswer {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

// One DoH query. Returns the addresses of the asked type, or a reason.
async function query(fetcher: Fetcher, host: string, type: "A" | "AAAA"): Promise<string[] | string> {
  const res = await fetcher(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, {
    method: "GET",
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return `DoH ${type} answered HTTP ${res.status}`;
  const body = (await res.json()) as DohAnswer;
  if (body.Status !== 0) return `DoH ${type} status ${body.Status}`;
  const want = type === "A" ? 1 : 28;
  return (body.Answer ?? []).filter((a) => a.type === want && typeof a.data === "string").map((a) => a.data as string);
}

// The A and AAAA addresses of a host, from KV or DoH. A string is a failure.
async function addresses(kv: KVNamespace, fetcher: Fetcher, host: string, ttl: number): Promise<string[] | string> {
  const cached = await kv.get(dnsCacheKey(host));
  if (cached !== null) return JSON.parse(cached) as string[];
  let a: string[] | string;
  let aaaa: string[] | string;
  try {
    [a, aaaa] = await Promise.all([query(fetcher, host, "A"), query(fetcher, host, "AAAA")]);
  } catch (err) {
    return `DoH failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (typeof a === "string") return a;
  if (typeof aaaa === "string") return aaaa;
  const all = [...a, ...aaaa];
  if (all.length === 0) return "no A or AAAA answer";
  await kv.put(dnsCacheKey(host), JSON.stringify(all), { expirationTtl: Math.max(ttl, KV_MIN_TTL) });
  return all;
}

// Fail closed: a DoH error is dns_failed (a retryable failed attempt), and
// any blocked answer is blocked_host. A residual gap stays: the platform
// resolves the host again for the POST (see the PR follow-ups).
export async function checkHost(kv: KVNamespace, fetcher: Fetcher, host: string, ttl: number): Promise<HostVerdict> {
  const r = await addresses(kv, fetcher, host, ttl);
  if (typeof r === "string") return { ok: false, reason: "dns_failed", detail: r };
  const bad = r.find(isBlockedAddress);
  if (bad !== undefined) return { ok: false, reason: "blocked_host", detail: `${host} resolves to ${bad}` };
  return { ok: true };
}
