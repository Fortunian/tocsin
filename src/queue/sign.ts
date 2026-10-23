import { toHex } from "../middleware/auth";

// Tocsin-Signature value: "sha256=" + hex HMAC-SHA256 of the raw body bytes,
// keyed with the watch list's webhook secret.
export async function signBody(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `sha256=${toHex(new Uint8Array(sig))}`;
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
