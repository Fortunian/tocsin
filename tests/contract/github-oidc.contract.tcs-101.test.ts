// contract-test
import { describe, expect, it } from "vitest";
import { GITHUB_OIDC_ISSUER, JWKS_URL } from "../../src/lib/github-oidc";

// Real-vendor contract suite for the GitHub OIDC seam (BH-7563 rule 4,
// TCS-101). Off the PR path: .github/workflows/mail-contract.yml runs it on
// main, nightly and on PRs that change src/lib/github-oidc.ts. It refuses to
// run unless TOCSIN_CONTRACT=1. Both URLs are free public GETs. A network
// error or a 5xx is a vendor failure: skip plus an alert line.

const ENABLED = process.env.TOCSIN_CONTRACT === "1";

type Skip = (note?: string) => never;

async function getJson(url: string, skip: Skip): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return vendorFailure(err, skip);
  }
  if (res.status >= 500) return vendorFailure(new Error(`HTTP ${res.status}`), skip);
  expect(res.status).toBe(200);
  return res.json();
}

function vendorFailure(err: unknown, skip: Skip): never {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(JSON.stringify({ lane: "oidc-contract", alert: "vendor_failure", vendor: "github-oidc", err: detail }));
  return skip(`vendor failure: ${detail}`);
}

describe.skipIf(!ENABLED)("GitHub OIDC (real vendor)", () => {
  it("C1: the openid-configuration issuer and jwks_uri match the seam's constants", async ({ skip }) => {
    const conf = (await getJson(`${GITHUB_OIDC_ISSUER}/.well-known/openid-configuration`, skip)) as { issuer?: string; jwks_uri?: string; id_token_signing_alg_values_supported?: string[] };
    expect(conf.issuer).toBe(GITHUB_OIDC_ISSUER);
    expect(conf.jwks_uri).toBe(JWKS_URL);
    expect(conf.id_token_signing_alg_values_supported).toContain("RS256");
  });

  it("C2: the JWKS has 1 or more RSA keys with a kid that WebCrypto imports", async ({ skip }) => {
    const jwks = (await getJson(JWKS_URL, skip)) as { keys?: (JsonWebKey & { kid?: string })[] };
    const rsa = (jwks.keys ?? []).filter((k) => k.kty === "RSA");
    expect(rsa.length).toBeGreaterThanOrEqual(1);
    for (const k of rsa) {
      expect(typeof k.kid).toBe("string");
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      expect(key.type).toBe("public");
    }
  });
});
