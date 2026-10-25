// Test helper for the GitHub OIDC seam (TCS-101): an RSA key pair made with
// WebCrypto, a JWT signer, and the JWKS seed in KV. The fake transport
// (GITHUB_OIDC_TRANSPORT=fake) never fetches GitHub, so each test seeds the
// keys it signs with.
import { env } from "cloudflare:workers";
import { GITHUB_OIDC_ISSUER, JWKS_CACHE_KEY } from "../../src/lib/github-oidc";

export const AUDIENCE = "tocsin.test";

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string; alg: string; use: string };
}

const ALG = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { kty: "RSA", n: pub.n, e: pub.e, kid, alg: "RS256", use: "sig" } };
}

export function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface Claims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  repository?: string;
  repository_owner?: string;
  repository_visibility?: string;
  ref?: string;
  run_id?: string;
  [k: string]: unknown;
}

// Claims as GitHub mints them for a push to main of a public repository.
export function claimsFor(repository: string, over: Partial<Claims> = {}): Claims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: GITHUB_OIDC_ISSUER,
    aud: AUDIENCE,
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
    repository,
    repository_owner: repository.split("/")[0],
    repository_visibility: "public",
    ref: "refs/heads/main",
    run_id: "1001",
    ...over,
  };
}

export async function sign(key: TestKey, claims: Claims, header: Record<string, unknown> = {}): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid, ...header }));
  const p = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

// Writes the JWKS cache entry the seam reads. fetchedAt in epoch ms.
export async function seedJwks(keys: TestKey[], fetchedAt = Date.now()): Promise<void> {
  await env.CURSORS.put(JWKS_CACHE_KEY, JSON.stringify({ fetched_at: fetchedAt, keys: keys.map((k) => k.jwk) }));
}

export async function clearJwks(): Promise<void> {
  await env.CURSORS.delete(JWKS_CACHE_KEY);
}
