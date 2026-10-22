import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

describe("GET /v1/health (production entry src/index.ts)", () => {
  it("returns 200 with ok:true and the package version", async () => {
    const res = await exports.default.fetch("https://tocsin.test/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: unknown; version: unknown };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(pkg.version);
  });

  it("does not answer other paths", async () => {
    const res = await exports.default.fetch("https://tocsin.test/v1/nope");
    expect(res.status).toBe(404);
  });
});
