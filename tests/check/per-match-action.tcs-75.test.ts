import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ECOSYSTEMS, normalizeOsv, type OsvVuln } from "../../src/ingest/osv";
import { upsertAdvisory } from "../../src/ingest/upsert";
import type { Advisory } from "../../src/schema/advisory";
import undici from "../fixtures/osv/undici-multi-range.tcs-75.json";

// TCS-75: a /v1/check item names the fix of the range the dependency matched,
// not the first line's fix. Every request goes through the production entry
// (src/index.ts) with its own client IP (RFC 5737).
//
// The fixture is source: assumed (see tests/ingest/osv-multi-range-action.tcs-75.test.ts).
// The record id gets the suffix -tcs75chk, so this file shares no row with another.

interface Item {
  dependency: { name: string; version: string };
  advisory_id: string;
  fixed_in: string | null;
  action: string;
}

let advisoryId = "";
let stored: Advisory;

beforeAll(async () => {
  const v = structuredClone(undici) as unknown as OsvVuln;
  v.id = `${v.id}-tcs75chk`;
  const r = normalizeOsv(v, DEFAULT_ECOSYSTEMS);
  if (!r.ok) throw new Error(r.reason);
  await upsertAdvisory(env.DB, r.doc, { source: "osv", source_id: v.id });
  const row = await env.DB.prepare(
    "SELECT a.id, a.doc_json FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id = ?",
  )
    .bind(v.id)
    .first<{ id: string; doc_json: string }>();
  advisoryId = row!.id;
  stored = JSON.parse(row!.doc_json) as Advisory;
});

async function check(version: string, ip: string): Promise<Item | undefined> {
  const res = await exports.default.fetch("https://tocsin.test/v1/check", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
    body: JSON.stringify({ dependencies: [{ ecosystem: "npm", name: "undici", version }] }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { affected: Item[] };
  return body.affected.find((x) => x.advisory_id === advisoryId);
}

describe("POST /v1/check per-match action (TCS-75)", () => {
  it("undici 7.29.0 names 7.29.1, not another line's fix", async () => {
    const item = await check("7.29.0", "198.51.100.175");
    expect(item?.fixed_in).toBe("7.29.1");
    expect(item?.action).toBe("Upgrade undici to 7.29.1 or later.");
    expect(item?.action).not.toContain("6.28.1");
    expect(item?.action).not.toContain("8.10.2");
  });

  it("undici 6.20.0 names 6.28.1", async () => {
    const item = await check("6.20.0", "198.51.100.176");
    expect(item?.fixed_in).toBe("6.28.1");
    expect(item?.action).toBe("Upgrade undici to 6.28.1 or later.");
    expect(item?.action).not.toContain("7.29.1");
  });

  it("undici 7.29.1 is not affected", async () => {
    expect(await check("7.29.1", "198.51.100.177")).toBeUndefined();
  });
});

describe("matchAction keeps the stored action outside the OSV multi-fix case", () => {
  it("a runtime source, a single fix and no fixed_in keep the stored text", async () => {
    // Loaded here, so the route tests above report their own result when this module is absent.
    const { matchAction } = await import("../../src/check/action");
    const runtime: Advisory = {
      ...stored,
      action: "Upgrade node to 22.1.1 (22.x) or 24.2.1 (24.x) or later.",
      sources: [{ source: "node-runtime", source_id: "x", url: "https://nodejs.org/" }],
    };
    expect(matchAction(runtime, "24.2.1")).toBe(runtime.action);

    const single: Advisory = {
      ...stored,
      // A stored text that differs from the computed one, so a kept action is visible.
      action: "Upgrade undici to the 6.x fix.",
      affected: stored.affected.slice(0, 1),
      fixed_versions: ["6.28.1"],
    };
    expect(matchAction(single, "6.28.1")).toBe(single.action);

    expect(matchAction(stored, undefined)).toBe(stored.action);
    expect(matchAction(stored, "8.10.2")).toBe("Upgrade undici to 8.10.2 or later.");
  });
});
