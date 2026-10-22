import { describe, expect, it } from "vitest";
import advisorySchema from "../../schema/advisory.v1.json";
import validateWellKnown from "../../src/schema/well-known.validate.generated.js";
import { get } from "./seed.tcs-3";

const ip = "198.51.100.20";
const JSON_UTF8 = "application/json; charset=utf-8";

describe("discovery files (production entry src/index.ts)", () => {
  it("serves /.well-known/tocsin.json, valid against schema/well-known.v1.json", async () => {
    const res = await get("/.well-known/tocsin.json", ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(JSON_UTF8);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as Record<string, unknown>;
    expect(validateWellKnown(body), JSON.stringify(validateWellKnown.errors)).toBe(true);
    expect(body.schema).toBe("https://tocsin.sh/schema/advisory.v1.json");
    expect(body.mcp).toBe("https://mcp.tocsin.sh");
    expect(body.docs).toBe("https://tocsin.sh/docs");

    // The validator is real: a copy without mcp fails it.
    const broken = structuredClone(body);
    delete broken.mcp;
    expect(validateWellKnown(broken)).toBe(false);
  });

  it("serves /llms.txt as text/plain with the cursor rule", async () => {
    const res = await get("/llms.txt", ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(text).toContain("since=");
    expect(text).toContain("next_cursor");
  });

  it("serves /schema/advisory.v1.json as the repo file", async () => {
    const res = await get("/schema/advisory.v1.json", ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(JSON_UTF8);
    expect(await res.json()).toEqual(advisorySchema);
  });

  it("sends CORS * and JSON utf-8 on /v1/events", async () => {
    const res = await get("/v1/events?ecosystem=eco-cors", ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toBe(JSON_UTF8);
  });

  it("answers an unknown path with 404 JSON {error}", async () => {
    const res = await get("/v1/nope", ip);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(JSON_UTF8);
    expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
  });
});
