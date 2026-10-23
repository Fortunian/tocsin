import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBackfill, type BackfillRow, type ImportAnswer, type ImportBody } from "../../scripts/backfill/osv-import.mjs";
import worker from "../../src/index";
import { buildZip, jsonEntry } from "./zip-fixture.tcs-32";

// TCS-38 round 2: one Debian OSV record holds up to 66 release docs (2.7 on
// average), and each doc costs about 3 D1 queries. POST /v1/internal/import caps
// the docs of one request (settings import.max_docs, default 200) and answers
// 413 with the cap before it writes anything. The script halves its batch and
// sends the same records again.
const TOKEN = "tok-fixture-docs-cap-38";
const ECO = "Debian";
const RELEASES = ["Debian:10", "Debian:11", "Debian:12", "Debian:13"];

function debianRecord(id: string, releases = RELEASES): Record<string, unknown> {
  return {
    id,
    modified: "2026-10-01T00:00:00Z",
    published: "2020-01-01T00:00:00Z",
    summary: `Fixture advisory ${id}`,
    affected: releases.map((ecosystem) => ({
      package: { ecosystem, name: `tcs38cap-${id}` },
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0-2" }] }],
    })),
    references: [{ type: "WEB", url: `https://example.com/fixture/${id}` }],
  };
}

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

const body = (ids: string[], extra: Partial<ImportBody> = {}) => ({ ecosystem: ECO, records: ids.map((id) => debianRecord(id)), skipped: 0, last_id: ids[ids.length - 1], final: false, ...extra });
const stored = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM advisory_sources WHERE source = 'osv' AND source_id LIKE 'DEBIAN-CVE-2038-%'").first<{ n: number }>())!.n;
const setMaxDocs = (n: number) => env.DB.prepare("INSERT INTO settings (key, value) VALUES ('import.max_docs', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(String(n)).run();

beforeEach(async () => {
  await env.DB.prepare("UPDATE sources SET config_json = ? WHERE id = 'osv'").bind(JSON.stringify({ ecosystems: [ECO] })).run();
  await env.DB.prepare("DELETE FROM backfill").run();
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'osv' AND source_id LIKE 'DEBIAN-CVE-2038-%')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'osv' AND source_id LIKE 'DEBIAN-CVE-2038-%'").run();
});

afterEach(async () => {
  await setMaxDocs(200);
});

describe("POST /v1/internal/import docs cap (settings import.max_docs)", () => {
  it("the migration seeds import.max_docs = 200, and GET reports it", async () => {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'import.max_docs'").first<{ value: string }>();
    expect(row?.value).toBe("200");
    const get = (await (await send("GET", `/${ECO}`)).json()) as { max_docs: number };
    expect(get.max_docs).toBe(200);
  });

  it("a batch over the cap answers 413 with the cap and writes nothing; a batch at the cap is written", async () => {
    await setMaxDocs(10);
    // 3 records x 4 releases = 12 docs > 10.
    const over = await send("POST", "", body(["DEBIAN-CVE-2038-0001", "DEBIAN-CVE-2038-0002", "DEBIAN-CVE-2038-0003"]));
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ max_docs: 10, docs: 12 });
    expect(await stored()).toBe(0);
    expect(await env.DB.prepare("SELECT 1 FROM backfill WHERE ecosystem = ?").bind(ECO).first()).toBeNull();
    // 2 records x 4 releases = 8 docs.
    const ok = await send("POST", "", body(["DEBIAN-CVE-2038-0001", "DEBIAN-CVE-2038-0002"]));
    expect(ok.status).toBe(200);
    expect(await stored()).toBe(8);
  });
});

describe("runBackfill halves its batch on a 413", () => {
  function client(posts: ImportBody[]) {
    return {
      get: async (): Promise<BackfillRow> => (await (await send("GET", `/${ECO}`)).json()) as BackfillRow,
      post: async (b: ImportBody): Promise<ImportAnswer> => {
        posts.push(b);
        const res = await send("POST", "", b);
        if (res.status !== 200) throw Object.assign(new Error(`POST ${res.status}: ${await res.text()}`), { status: res.status });
        return (await res.json()) as ImportAnswer;
      },
    };
  }

  it("a 4-record batch of 16 docs over a cap of 10 is sent again as 2 + 2; every record is stored and the run is done", async () => {
    await setMaxDocs(10);
    const ids = Array.from({ length: 9 }, (_, i) => `DEBIAN-CVE-2038-${String(i + 1).padStart(4, "0")}`);
    const zip = await buildZip(ids.map((id) => jsonEntry(debianRecord(id))));
    const posts: ImportBody[] = [];
    const totals = await runBackfill({ zip, ecosystem: ECO, batch: 4, ...client(posts) });
    expect(totals.done_at).not.toBeNull();
    expect(totals.imported).toBe(9);
    expect(await stored()).toBe(36);
    // The first post (4 records) is refused, then every post holds at most 2 records.
    expect(posts[0].records).toHaveLength(4);
    expect(posts.slice(1).every((p) => p.records.length <= 2)).toBe(true);
    // The watermark of each written part is its own last record, and only the first written part starts the run.
    const written = posts.slice(1);
    expect(written.filter((p) => p.start === true)).toHaveLength(1);
    expect(written[0].start).toBe(true);
    for (const p of written) if (p.records.length > 0) expect(p.last_id >= String((p.records[p.records.length - 1] as { id: string }).id)).toBe(true);
    expect(written[0].last_id).toBe("DEBIAN-CVE-2038-0002");
    const row = await env.DB.prepare("SELECT last_id, done_at FROM backfill WHERE ecosystem = ?").bind(ECO).first<{ last_id: string; done_at: string | null }>();
    expect(row).toMatchObject({ last_id: "DEBIAN-CVE-2038-0009" });
    expect(row?.done_at).not.toBeNull();
  });

  it("one record over the cap fails the run; it does not loop", async () => {
    await setMaxDocs(3);
    const zip = await buildZip([jsonEntry(debianRecord("DEBIAN-CVE-2038-0001"))]);
    const posts: ImportBody[] = [];
    await expect(runBackfill({ zip, ecosystem: ECO, batch: 4, ...client(posts) })).rejects.toThrow(/413/);
    expect(posts).toHaveLength(1);
    expect(await stored()).toBe(0);
  });
});
