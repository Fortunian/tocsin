import { toHex } from "../middleware/auth";

// The signed string is "<timestamp>.<raw body>", so a captured body and
// signature cannot be replayed under a new timestamp. Tocsin-Signature is
// "v1=" + hex HMAC-SHA256 of it, keyed with the watch list's webhook secret.
// Receiver steps: docs/API.md "Verify a delivery".
export async function signPayload(secret: string, timestamp: number, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`));
  return `v1=${toHex(new Uint8Array(sig))}`;
}

// The two signature headers of one attempt. timestamp is Unix seconds.
export async function signatureHeaders(secret: string, body: string, timestamp: number): Promise<Record<string, string>> {
  return { "Tocsin-Timestamp": String(timestamp), "Tocsin-Signature": await signPayload(secret, timestamp, body) };
}

// Tocsin-Event-Id: the same for every attempt of one delivery, so a receiver
// can drop a repeat.
export function eventId(watchlistId: string, advisoryId: string): string {
  return `${watchlistId}:${advisoryId}`;
}

// A new webhook secret: "whsec_" + 32 random bytes as hex.
export function newWebhookSecret(): string {
  return `whsec_${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}
