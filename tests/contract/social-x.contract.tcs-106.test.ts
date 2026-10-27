// contract-test
import { describe, expect, it } from "vitest";
import { RealX, type XCredentials, type XPostResult } from "../../src/social/x";

// Real-vendor contract suite for the X adapter (BH-7563 rule 4, TCS-106).
// Off the PR path: .github/workflows/social-contract.yml runs it on main,
// nightly and on PRs that change src/social/x.ts, src/social/oauth1.ts or this
// file. It refuses to run unless TOCSIN_CONTRACT=1 (only `npm run
// test:contract` sets it), and each test skips without the four X secrets.
// A billing answer (no credits, comment 6447345509), a 429, a 5xx or a
// network error is a vendor failure, never a code failure: skip with a reason
// plus one alert line (BH-7563 rule 7). The credits are bought (comment
// 6447444139), so the normal run makes one real post to @tocsinagent (about
// $0.20) and deletes it at once.

export const CONTRACT_ENABLED = process.env.TOCSIN_CONTRACT === "1";
const env = CONTRACT_ENABLED ? process.env : {};
const CREDS: XCredentials | null =
  env.X_CONSUMER_KEY && env.X_CONSUMER_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_TOKEN_SECRET
    ? { consumerKey: env.X_CONSUMER_KEY, consumerSecret: env.X_CONSUMER_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_TOKEN_SECRET }
    : null;
const NO_SECRETS = "X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN or X_ACCESS_TOKEN_SECRET not set";
const TIMEOUT_MS = 15_000;

type Skip = (note?: string) => never;

function vendorFailure(detail: string, skip: Skip): never {
  console.error(JSON.stringify({ lane: "social-contract", alert: "vendor_failure", vendor: "x", err: detail }));
  return skip(`vendor failure: ${detail}`);
}

// A billing, retryable (429/5xx) or network answer skips; every other answer is returned.
function vendorGate(o: XPostResult, skip: Skip): XPostResult {
  if (o.kind === "billing" || o.kind === "retryable" || o.kind === "network") return vendorFailure(`${o.kind}: ${o.error ?? `x answered ${o.status}`}`, skip);
  return o;
}

describe.skipIf(!CONTRACT_ENABLED)("X adapter against the real API", () => {
  it("posts one [contract test] message to @tocsinagent and deletes it", async (ctx) => {
    if (!CREDS) return ctx.skip(NO_SECRETS);
    const x = new RealX(CREDS, TIMEOUT_MS);
    const o = vendorGate(await x.post(`[contract test] Tocsin X adapter check ${new Date().toISOString()}`), ctx.skip);
    expect(o.kind).toBe("ok");
    expect(o.id).toMatch(/^\d+$/);
    const del = await x.remove(o.id!);
    if (del.kind === "network") return vendorFailure(del.error, ctx.skip);
    expect(del).toEqual({ kind: "ok", deleted: true });
  });

  it("a wrong consumer secret answers 401, which the seam classifies as terminal (no post, no retry)", async (ctx) => {
    if (!CREDS) return ctx.skip(NO_SECRETS);
    const x = new RealX({ ...CREDS, consumerSecret: "cs-fixture-invalid" }, TIMEOUT_MS);
    const o = vendorGate(await x.post("[contract test] must not post"), ctx.skip);
    expect(o).toMatchObject({ kind: "terminal", status: 401 });
  });
});
