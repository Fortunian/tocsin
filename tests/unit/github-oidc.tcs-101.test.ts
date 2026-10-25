import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JwksFetchError, OidcError, verifyGithubOidc } from "../../src/lib/github-oidc";
import { setKnob } from "../queue/helpers.tcs-11";
import { AUDIENCE, claimsFor, clearJwks, makeKey, seedJwks, sign, type TestKey } from "../routes/oidc-helpers.tcs-101";

// TCS-101: the GitHub OIDC seam with an injected, counting JWKS fetcher.

let a: TestKey;
let b: TestKey;
beforeAll(async () => {
  a = await makeKey("kid-fixture-a");
  b = await makeKey("kid-fixture-b");
});
beforeEach(async () => {
  await clearJwks();
  await setKnob("action.oidc_clock_skew_seconds", "60");
  await setKnob("action.oidc_jwks_refetch_seconds", "300");
});

function counter(keys: TestKey[]) {
  const f = async () => {
    f.calls += 1;
    return keys.map((k) => k.jwk);
  };
  f.calls = 0;
  return f;
}

const nowS = () => Math.floor(Date.now() / 1000);

describe("verifyGithubOidc", () => {
  it("O1: an empty cache fetches once and returns the claims; the next call uses the cache", async () => {
    const f = counter([a]);
    const t = await sign(a, claimsFor("acme/widget"));
    const c = await verifyGithubOidc(env, t, AUDIENCE, new Date(), f);
    expect(c).toMatchObject({ repository: "acme/widget", ref: "refs/heads/main", run_id: "1001", repository_visibility: "public" });
    await verifyGithubOidc(env, t, AUDIENCE, new Date(), f);
    expect(f.calls).toBe(1);
  });

  it("O2: an unknown kid with a stale cache refetches once and accepts the new key", async () => {
    await seedJwks([a], Date.now() - 600_000);
    const f = counter([a, b]);
    const c = await verifyGithubOidc(env, await sign(b, claimsFor("acme/widget")), AUDIENCE, new Date(), f);
    expect(c.repository).toBe("acme/widget");
    expect(f.calls).toBe(1);
  });

  it("O3: an unknown kid with a fresh cache does not refetch and is refused", async () => {
    await seedJwks([a], Date.now() - 10_000);
    const f = counter([a, b]);
    await expect(verifyGithubOidc(env, await sign(b, claimsFor("acme/widget")), AUDIENCE, new Date(), f)).rejects.toBeInstanceOf(OidcError);
    expect(f.calls).toBe(0);
  });

  it("O4: a failed JWKS fetch throws JwksFetchError, not OidcError", async () => {
    const t = await sign(a, claimsFor("acme/widget"));
    const err = await verifyGithubOidc(env, t, AUDIENCE, new Date(), async () => {
      throw new JwksFetchError("fixture: HTTP 502");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JwksFetchError);
    expect(err).not.toBeInstanceOf(OidcError);
    expect(await env.CURSORS.get("oidc:github:jwks")).toBeNull();
  });

  it("O5: exp in the past inside the skew is accepted; past the skew it is refused", async () => {
    await seedJwks([a]);
    const inside = await sign(a, claimsFor("acme/widget", { exp: nowS() - 30 }));
    await expect(verifyGithubOidc(env, inside, AUDIENCE, new Date(), counter([]))).resolves.toMatchObject({ repository: "acme/widget" });
    const outside = await sign(a, claimsFor("acme/widget", { exp: nowS() - 120 }));
    await expect(verifyGithubOidc(env, outside, AUDIENCE, new Date(), counter([]))).rejects.toThrow(/expired/);
    await setKnob("action.oidc_clock_skew_seconds", "300");
    await expect(verifyGithubOidc(env, outside, AUDIENCE, new Date(), counter([]))).resolves.toMatchObject({ repository: "acme/widget" });
  });

  it("O6: nbf in the future past the skew is refused", async () => {
    await seedJwks([a]);
    const t = await sign(a, claimsFor("acme/widget", { nbf: nowS() + 600 }));
    await expect(verifyGithubOidc(env, t, AUDIENCE, new Date(), counter([]))).rejects.toThrow(/not yet valid/);
  });

  it("O7: a token with no run_id or no ref claim is refused", async () => {
    await seedJwks([a]);
    const noRun = await sign(a, claimsFor("acme/widget", { run_id: undefined }));
    await expect(verifyGithubOidc(env, noRun, AUDIENCE, new Date(), counter([]))).rejects.toBeInstanceOf(OidcError);
    const noRef = await sign(a, claimsFor("acme/widget", { ref: undefined }));
    await expect(verifyGithubOidc(env, noRef, AUDIENCE, new Date(), counter([]))).rejects.toBeInstanceOf(OidcError);
  });

  it("O8: the default fetcher under GITHUB_OIDC_TRANSPORT=fake makes no network call and throws JwksFetchError", async () => {
    expect(env.GITHUB_OIDC_TRANSPORT).toBe("fake");
    const t = await sign(a, claimsFor("acme/widget"));
    await expect(verifyGithubOidc(env, t, AUDIENCE, new Date())).rejects.toThrow(/fake OIDC transport/);
  });
});
