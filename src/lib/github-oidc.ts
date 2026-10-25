import type { Env } from "../env";
import { getSettingInt } from "./settings";

// The one seam for GitHub Actions OIDC (TCS-101). It verifies the RS256 JWT a
// workflow run mints (permission `id-token: write`) against GitHub's JWKS.
// The JWKS is cached in KV. With GITHUB_OIDC_TRANSPORT=fake (vitest.config.ts
// only) the default fetcher refuses the network, so a test seeds the cache.
// This file is the only one that names the GitHub OIDC URLs.

// Protocol constants, not knobs: the issuer GitHub signs as, and its key set.
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
export const JWKS_CACHE_KEY = "oidc:github:jwks";

// Code fallbacks only. The live values are settings.action.oidc_jwks_cache_seconds,
// settings.action.oidc_jwks_refetch_seconds and settings.action.oidc_clock_skew_seconds.
export const FALLBACK_JWKS_CACHE_SECONDS = 3600;
export const FALLBACK_JWKS_REFETCH_SECONDS = 300;
export const FALLBACK_CLOCK_SKEW_SECONDS = 60;
// Workers KV refuses an expirationTtl under 60 seconds (a platform limit, not a knob).
const KV_MIN_TTL_SECONDS = 60;

export interface GithubOidcClaims {
  repository: string;
  repository_owner: string | null;
  ref: string;
  run_id: string;
  repository_visibility: string | null;
}

// The token is not acceptable. The route answers 401.
export class OidcError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "OidcError";
  }
}

// The key set could not be read. The route answers 503: no token was judged.
export class JwksFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwksFetchError";
  }
}

export type Jwk = JsonWebKey & { kid?: string };
export type JwksFetcher = () => Promise<Jwk[]>;

interface CachedJwks {
  fetched_at: number;
  keys: Jwk[];
}

export function defaultFetcher(env: Pick<Env, "GITHUB_OIDC_TRANSPORT">): JwksFetcher {
  return async () => {
    if (env.GITHUB_OIDC_TRANSPORT === "fake") throw new JwksFetchError("fake OIDC transport: seed oidc:github:jwks in KV");
    let res: Response;
    try {
      res = await fetch(JWKS_URL, { headers: { Accept: "application/json" } });
    } catch (err) {
      throw new JwksFetchError(`GET ${JWKS_URL}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new JwksFetchError(`GET ${JWKS_URL}: HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { keys?: unknown } | null;
    if (!body || !Array.isArray(body.keys)) throw new JwksFetchError(`GET ${JWKS_URL}: no keys array`);
    return body.keys.filter((k): k is Jwk => typeof k === "object" && k !== null && (k as Jwk).kty === "RSA" && typeof (k as Jwk).kid === "string");
  };
}

function b64urlBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new OidcError("malformed token");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
  } catch {
    throw new OidcError("malformed token");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new OidcError("malformed token");
  return v as Record<string, unknown>;
}

async function loadCache(env: Pick<Env, "CURSORS">): Promise<CachedJwks | null> {
  const raw = await env.CURSORS.get(JWKS_CACHE_KEY);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as CachedJwks;
    if (typeof v.fetched_at === "number" && Array.isArray(v.keys)) return v;
  } catch {
    // A broken cache entry is a miss.
  }
  return null;
}

async function refresh(env: Pick<Env, "CURSORS">, fetchJwks: JwksFetcher, nowMs: number, ttl: number): Promise<CachedJwks> {
  const keys = await fetchJwks();
  const entry = { fetched_at: nowMs, keys };
  await env.CURSORS.put(JWKS_CACHE_KEY, JSON.stringify(entry), { expirationTtl: Math.max(KV_MIN_TTL_SECONDS, ttl) });
  return entry;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

// Verifies a GitHub Actions OIDC token for `audience` and returns its claims.
// Throws OidcError when the token is not acceptable and JwksFetchError when
// the key set cannot be read. An unknown kid refetches the key set at most
// once per action.oidc_jwks_refetch_seconds, so junk kids cannot flood GitHub.
export async function verifyGithubOidc(
  env: Pick<Env, "DB" | "CURSORS" | "GITHUB_OIDC_TRANSPORT">,
  token: string,
  audience: string,
  now: Date,
  fetchJwks: JwksFetcher = defaultFetcher(env),
): Promise<GithubOidcClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("malformed token");
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  if (header.alg !== "RS256") throw new OidcError("alg must be RS256");
  const kid = str(header.kid);
  if (kid === null) throw new OidcError("no kid");
  const signature = b64urlBytes(parts[2]);

  const [cacheSeconds, refetchSeconds, skew] = await Promise.all([
    getSettingInt(env.DB, "action.oidc_jwks_cache_seconds", FALLBACK_JWKS_CACHE_SECONDS),
    getSettingInt(env.DB, "action.oidc_jwks_refetch_seconds", FALLBACK_JWKS_REFETCH_SECONDS),
    getSettingInt(env.DB, "action.oidc_clock_skew_seconds", FALLBACK_CLOCK_SKEW_SECONDS),
  ]);
  const nowMs = now.getTime();
  let jwks = await loadCache(env);
  let fresh = false;
  if (jwks === null) {
    jwks = await refresh(env, fetchJwks, nowMs, cacheSeconds);
    fresh = true;
  }
  let jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk && !fresh && nowMs - jwks.fetched_at > refetchSeconds * 1000) {
    jwks = await refresh(env, fetchJwks, nowMs, cacheSeconds);
    jwk = jwks.keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new OidcError("unknown kid");

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch {
    throw new OidcError("unusable key");
  }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new OidcError("bad signature");

  if (payload.iss !== GITHUB_OIDC_ISSUER) throw new OidcError("wrong issuer");
  const aud = payload.aud;
  if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) throw new OidcError("wrong audience");
  const nowS = nowMs / 1000;
  if (typeof payload.exp !== "number" || payload.exp <= nowS - skew) throw new OidcError("token expired");
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > nowS + skew)) throw new OidcError("token not yet valid");

  const repository = str(payload.repository);
  const ref = str(payload.ref);
  const runId = typeof payload.run_id === "number" ? String(payload.run_id) : str(payload.run_id);
  if (repository === null || ref === null || runId === null) throw new OidcError("missing repository, ref or run_id claim");
  return {
    repository,
    repository_owner: str(payload.repository_owner),
    ref,
    run_id: runId,
    repository_visibility: str(payload.repository_visibility),
  };
}
