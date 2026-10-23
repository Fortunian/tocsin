import { exports } from "cloudflare:workers";

// Every caller gets its own client IP (RFC 3849 documentation range), so the
// per-IP rate limit on POST /v1/keys never couples two tests.
let ipSeq = 0;
export function nextIp(): string {
  ipSeq += 1;
  return `2001:db8::${ipSeq.toString(16)}`;
}

export function uniqueEmail(tag: string): string {
  return `${tag}-${crypto.randomUUID()}@example.test`;
}

export interface CallOpts {
  key?: string;
  body?: unknown;
  rawBody?: string;
  ip?: string;
  headers?: Record<string, string>;
}

// Drives the production entry point (src/index.ts default export).
export function call(method: string, path: string, opts: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { "CF-Connecting-IP": opts.ip ?? nextIp(), ...opts.headers };
  if (opts.key !== undefined) headers.Authorization = `Bearer ${opts.key}`;
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined && !("Content-Type" in headers)) headers["Content-Type"] = "application/json";
  return exports.default.fetch(`https://tocsin.test${path}`, { method, headers, body });
}

export async function newKey(email: string = uniqueEmail("k")): Promise<{ key: string; key_id: string; email: string }> {
  const res = await call("POST", "/v1/keys", { body: { email } });
  if (res.status !== 201) throw new Error(`POST /v1/keys answered ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { key: string; key_id: string; email: string };
  return body;
}

export async function sha256HexOf(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
