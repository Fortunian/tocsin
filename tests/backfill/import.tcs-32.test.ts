import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readZip, runBackfill, type BackfillRow, type ImportAnswer, type ImportBody } from "../../scripts/backfill/osv-import.mjs";
import worker from "../../src/index";
import { buildZip, jsonEntry, osvRecord } from "./zip-fixture.tcs-32";

// The backfill script core (scripts/backfill/osv-import.mjs) against the real
// worker: every POST and GET goes to src/index.ts with a test IMPORT_TOKEN.
// The zip is built in memory: 990 valid records, 5 MAL- and 5 withdrawn.
const TOKEN = "tok-fixture-backfill-32";
const ECO = "crates.io";

async function send(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(
    new Request(`https://tocsin.test/v1/internal/import${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    { ...env, IMPORT_TOKEN: TOKEN },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

interface Calls {
  posts: ImportBody[];
}

function client(calls: Calls, opts: { failAfter?: number } = {}) {
  return {
    get: async (): Promise<BackfillRow> => {
      const res = await send("GET", `/${encodeURIComponent(ECO)}`);
      if (res.status !== 200) throw new Error(`GET ${res.status}`);
      return (await res.json()) as BackfillRow;
    },
    post: async (body: ImportBody): Promise<ImportAnswer> => {
      if (opts.failAfter !== undefined && calls.posts.length >= opts.failAfter) throw new Error("killed: the runner stopped");
      calls.posts.push(body);
      const res = await send("POST", "", body);
      if (res.status !== 200) throw new Error(`POST ${res.status}: ${await res.text()}`);
      return (await res.json()) as ImportAnswer;
    },
  };
}

let zip: Uint8Array;
beforeAll(async () => {
  const entries = [];
  for (let i = 0; i < 990; i++) {
    const id = `RUSTSEC-2020-${String(i).padStart(4, "0")}`;
    // Every third entry is stored, the rest deflate-raw, so both methods are read.
    entries.push(jsonEntry(osvRecord(id, ECO, `tcs32-crate-${i}`, { published: `2016-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` }), i % 3 === 0));
  }
  for (let i = 0; i < 5; i++) entries.push(jsonEntry(osvRecord(`MAL-2026-${i}`, ECO, `tcs32-mal-${i}`)));
  for (let i = 0; i < 5; i++) entries.push(jsonEntry(osvRecord(`RUSTSEC-2021-${String(i).padStart(4, "0")}`, ECO, `tcs32-wd-${i}`, { withdrawn: true })));
  // Unsorted on purpose: the script sorts by id.
  entries.reverse();
  zip = await buildZip(entries, { zip64: true });
});

beforeEach(async () => {
  await env.DB.prepare("UPDATE sources SET config_json = ? WHERE id = 'osv'").bind(JSON.stringify({ ecosystems: [ECO] })).run();
  await env.DB.prepare("DELETE FROM backfill").run();
  // These tests cut 990 records with a server cap of 500 (the seed is 100).
  await env.DB.prepare("UPDATE settings SET value = '500' WHERE key = 'import.max_batch'").run();
  // TCS-38: a request also caps its release docs (import.max_docs, seed 200); one doc per record here.
  await env.DB.prepare("UPDATE settings SET value = '500' WHERE key = 'import.max_docs'").run();
  // Each test starts with none of this file's advisories stored.
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'osv' AND source_id LIKE 'RUSTSEC-202%')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'osv' AND source_id LIKE 'RUSTSEC-202%'").run();
});

afterEach(async () => {
  await env.DB.prepare("UPDATE settings SET value = '100' WHERE key = 'import.max_batch'").run();
  await env.DB.prepare("UPDATE settings SET value = '200' WHERE key = 'import.max_docs'").run();
});

const backfillRow = () => env.DB.prepare("SELECT * FROM backfill WHERE ecosystem = ?").bind(ECO).first<Record<string, unknown>>();
const osvRows = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM advisory_sources WHERE source = 'osv' AND source_id LIKE 'RUSTSEC-202%'").first<{ n: number }>())!.n;

describe("readZip", () => {
  it("lists every entry of a ZIP64 archive and inflates both stored and deflate entries", async () => {
    const z = await readZip(zip);
    expect(z.entries).toHaveLength(1000);
    const stored = z.entries.find((e) => e.name === "RUSTSEC-2020-0000.json")!;
    const deflated = z.entries.find((e) => e.name === "RUSTSEC-2020-0001.json")!;
    expect(stored.method).toBe(0);
    expect(deflated.method).toBe(8);
    expect(JSON.parse(new TextDecoder().decode(await z.read(deflated))).id).toBe("RUSTSEC-2020-0001");
    expect(JSON.parse(new TextDecoder().decode(await z.read(stored))).id).toBe("RUSTSEC-2020-0000");
  });

  it("refuses bytes that are not a zip", async () => {
    await expect(readZip(new TextEncoder().encode("not a zip"))).rejects.toThrow(/zip/i);
  });
});

describe("runBackfill against the worker", { timeout: 120_000 }, () => {
  it("imports 990 in 2 batches of 500, skips and counts 10, sets done_at; a second run imports 0 and reports 990 unchanged", async () => {
    const calls: Calls = { posts: [] };
    const first = await runBackfill({ zip, ecosystem: ECO, batch: 500, ...client(calls) });
    expect(calls.posts).toHaveLength(2);
    expect(calls.posts.map((p) => p.records.length)).toEqual([500, 490]);
    expect(calls.posts.map((p) => Boolean(p.final))).toEqual([false, true]);
    expect(first).toMatchObject({ imported: 990, unchanged: 0, skipped: 10 });
    expect(await osvRows()).toBe(990);
    const row = await backfillRow();
    expect(row).toMatchObject({ imported: 990, unchanged: 0, skipped: 10, last_id: "RUSTSEC-2021-0004", coverage_since: "2016-01-01T00:00:00Z" });
    expect(row!.done_at).not.toBeNull();
    const osv = await env.DB.prepare("SELECT coverage_since FROM sources WHERE id = 'osv'").first<{ coverage_since: string | null }>();
    expect(osv!.coverage_since).toBe("2016-01-01T00:00:00Z");

    const again: Calls = { posts: [] };
    const second = await runBackfill({ zip, ecosystem: ECO, batch: 500, ...client(again) });
    expect(second).toMatchObject({ imported: 0, unchanged: 990, skipped: 10 });
    expect(again.posts).toHaveLength(2);
    expect(await osvRows()).toBe(990);
    expect(await backfillRow()).toMatchObject({ imported: 0, unchanged: 990, done_at: row!.done_at });
  });

  it("a run killed after batch 1 resumes at last_id and sends only batch 2", async () => {
    const killed: Calls = { posts: [] };
    await expect(runBackfill({ zip, ecosystem: ECO, batch: 500, ...client(killed, { failAfter: 1 }) })).rejects.toThrow(/killed/);
    expect(killed.posts).toHaveLength(1);
    const mid = await backfillRow();
    expect(mid!.done_at).toBeNull();
    expect(mid!.last_id).toBe(killed.posts[0].last_id);

    const resumed: Calls = { posts: [] };
    const r = await runBackfill({ zip, ecosystem: ECO, batch: 500, ...client(resumed) });
    expect(resumed.posts).toHaveLength(1);
    expect(resumed.posts[0].final).toBe(true);
    expect(resumed.posts[0].records.every((x) => String(x.id) > killed.posts[0].last_id)).toBe(true);
    expect(resumed.posts[0].start).toBeFalsy();
    expect(r.imported).toBe(490);
    const row = await backfillRow();
    expect(row).toMatchObject({ imported: 990, skipped: 10 });
    expect(row!.done_at).not.toBeNull();
  });

  it("the batch size never passes the server's max_batch", async () => {
    await env.DB.prepare("UPDATE settings SET value = '400' WHERE key = 'import.max_batch'").run();
    try {
      const calls: Calls = { posts: [] };
      await runBackfill({ zip, ecosystem: ECO, batch: 500, ...client(calls) });
      expect(calls.posts.map((p) => p.records.length)).toEqual([400, 400, 190]);
    } finally {
      await env.DB.prepare("UPDATE settings SET value = '500' WHERE key = 'import.max_batch'").run();
    }
  });
});
