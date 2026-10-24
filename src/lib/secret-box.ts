import type { Env } from "../env";

// Webhook secrets at rest (TCS-82). AES-256-GCM through Web Crypto, keyed with
// the Worker secret WEBHOOK_KEK (32 bytes as base64). Each write takes a new
// random 12-byte IV. The AAD is the watch list id, so a ciphertext copied to
// another row does not decrypt. Stored form: "v1:<base64 iv>:<base64 ciphertext>".

const VERSION = "v1";
// AES-GCM's standard IV size and the AES-256 key size: properties of the
// cipher, not knobs.
const IV_BYTES = 12;
const KEK_BYTES = 32;

const enc = new TextEncoder();

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Throws when the value is not base64 of exactly 32 bytes.
export async function importKek(b64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = fromB64(b64.trim());
  } catch {
    throw new Error("WEBHOOK_KEK is not base64");
  }
  if (raw.length !== KEK_BYTES) throw new Error(`WEBHOOK_KEK must be ${KEK_BYTES} bytes, got ${raw.length}`);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(kek: CryptoKey, aad: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, kek, enc.encode(plain));
  return `${VERSION}:${toB64(iv)}:${toB64(new Uint8Array(ct))}`;
}

// Throws on a malformed value, a wrong KEK or a wrong AAD (GCM tag check).
export async function decryptSecret(kek: CryptoKey, aad: string, stored: string): Promise<string> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== VERSION) throw new Error("webhook_secret_enc has an unknown format");
  const iv = fromB64(parts[1]);
  if (iv.length !== IV_BYTES) throw new Error("webhook_secret_enc has a bad IV");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, kek, fromB64(parts[2]));
  return new TextDecoder().decode(pt);
}

// The KEK of this Worker, or null when WEBHOOK_KEK is unset or unusable. A
// null is logged once per call (kek_missing or kek_invalid), never with the
// value. Callers then keep the plaintext path (docs/RETENTION.md).
export async function loadKek(env: Env, lane: string): Promise<CryptoKey | null> {
  if (!env.WEBHOOK_KEK) {
    console.error(JSON.stringify({ lane, err: "kek_missing: WEBHOOK_KEK is not set, webhook secrets stay plaintext" }));
    return null;
  }
  try {
    return await importKek(env.WEBHOOK_KEK);
  } catch (err) {
    console.error(JSON.stringify({ lane, err: `kek_invalid: ${err instanceof Error ? err.message : String(err)}` }));
    return null;
  }
}
