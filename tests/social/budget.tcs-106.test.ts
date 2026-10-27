import { env } from "cloudflare:workers";
import { replay } from "./replay-call.tcs-106";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import { runSocialLane } from "../../src/cron/social";
import { FakeX } from "../../src/social/fake";
import { getXClient, RealX } from "../../src/social/x";
import { callsFor, resetSocial, seedAdvisory } from "./helpers.tcs-106";

// TCS-106 budget (BH-7563 rule 6): the PR suite makes 0 X calls. The api
// project binds SOCIAL_TRANSPORT=fake (vitest.config.ts), so the X seam
// answers the KV fake.

const urlOf = (c: unknown[]) => String(c[0] instanceof Request ? c[0].url : c[0]);

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetSocial();
});
afterEach(() => vi.restoreAllMocks());

describe("X seam budget", () => {
  it("G1: getXClient answers the fake under the test binding, even with all four secrets set", () => {
    expect(env.SOCIAL_TRANSPORT).toBe("fake");
    expect(getXClient(env, 1000)).toBeInstanceOf(FakeX);
    const secrets = { X_CONSUMER_KEY: "ck-fixture", X_CONSUMER_SECRET: "cs-fixture", X_ACCESS_TOKEN: "tok-fixture", X_ACCESS_TOKEN_SECRET: "ts-fixture" };
    expect(getXClient({ ...env, ...secrets }, 1000)).toBeInstanceOf(FakeX);
  });

  it("G2: with the fake off, a missing secret answers null and all four answer the real adapter", () => {
    const off = { ...env, SOCIAL_TRANSPORT: undefined };
    expect(getXClient(off, 1000)).toBeNull();
    expect(getXClient({ ...off, X_CONSUMER_KEY: "ck-fixture", X_CONSUMER_SECRET: "cs-fixture", X_ACCESS_TOKEN: "tok-fixture" }, 1000)).toBeNull();
    expect(
      getXClient({ ...off, X_CONSUMER_KEY: "ck-fixture", X_CONSUMER_SECRET: "cs-fixture", X_ACCESS_TOKEN: "tok-fixture", X_ACCESS_TOKEN_SECRET: "ts-fixture" }, 1000),
    ).toBeInstanceOf(RealX);
  });

  it("G3: an enabled lane run and a replay make 0 fetch calls (0 to api.x.com)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const a = await seedAdvisory();
    await runSocialLane(env, new Date());
    expect(await callsFor(a.id)).toHaveLength(1);
    const b = await seedAdvisory({ severity: "medium" });
    const res = await replay({ advisory_id: b.id });
    expect(res.status).toBe(200);
    expect(await callsFor(b.id)).toHaveLength(1);
    expect(spy.mock.calls.filter((c) => urlOf(c).includes("api.x.com"))).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("G4: npm test runs no contract project; test:contract runs it with TOCSIN_CONTRACT=1", () => {
    expect(pkg.scripts.test).not.toMatch(/--project\s+contract/);
    expect(pkg.scripts["test:contract"]).toContain("TOCSIN_CONTRACT=1");
    expect(pkg.scripts["test:contract"]).toMatch(/--project contract/);
  });
});
