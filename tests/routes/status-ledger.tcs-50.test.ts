import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ledgerSql } from "../../src/ingest/ledgers";
import { loadStatus } from "../../src/site/data";
import { get } from "./seed.tcs-3";

// TCS-50: ledger counts in GET /v1/status and /status, through the production
// entry (src/index.ts -> app). Each case seeds its own python_runtime_records.
const ip = "198.51.100.50";
const AT = "2026-10-22T22:00:00Z";
const NO_LEDGER = ["osv", "nvd", "kev", "epss", "node-runtime", "php-runtime"];

interface Src {
  id: string;
  ledger?: unknown;
}

// Rows per state; `failed` rows with a due time are retrying, without one terminal.
async function seedLedger(tag: string, counts: { ok: number; empty: number; pending: number; retrying: number; terminal: number }): Promise<void> {
  const rows: [string, string | null][] = [
    ...Array.from({ length: counts.ok }, () => ["ok", null] as [string, null]),
    ...Array.from({ length: counts.empty }, () => ["empty", null] as [string, null]),
    ...Array.from({ length: counts.pending }, () => ["pending", AT] as [string, string]),
    ...Array.from({ length: counts.retrying }, () => ["failed", AT] as [string, string]),
    ...Array.from({ length: counts.terminal }, () => ["failed", null] as [string, null]),
  ];
  const insert = env.DB.prepare("INSERT INTO python_runtime_records (psf_id, state, attempts, next_check_at, updated_at) VALUES (?, ?, 0, ?, ?)");
  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(rows.slice(i, i + 50).map(([state, next], j) => insert.bind(`PSF-2050-${tag}-${i + j}`, state, next, AT)));
  }
}

async function statusJson(): Promise<Src[]> {
  const res = await get("/v1/status", ip);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sources: Src[] }).sources;
}

const CASE1 = { ok: 3, empty: 1, pending: 2, retrying: 2, terminal: 1 };

// This file owns its D1 storage; the ledger starts empty in every case.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM python_runtime_records").run();
  await env.DB.prepare("UPDATE sources SET last_warning = NULL").run();
});

describe("GET /v1/status ledger counts", () => {
  it("case 1: seeded ledger rows yield the right counts for python-runtime", async () => {
    await seedLedger("c1", CASE1);
    const py = (await statusJson()).find((s) => s.id === "python-runtime");
    expect(py?.ledger).toEqual({ ok: 3, empty: 1, pending: 2, failed_retrying: 2, failed_terminal: 1 });
  });

  it("case 2: a source with no ledger has no ledger key", async () => {
    await seedLedger("c2", CASE1);
    const sources = await statusJson();
    for (const id of NO_LEDGER) {
      const s = sources.find((x) => x.id === id);
      expect(s, id).toBeDefined();
      expect(s, id).not.toHaveProperty("ledger");
    }
  });

  it("case 3: an empty ledger table reads as measured zeros", async () => {
    const py = (await statusJson()).find((s) => s.id === "python-runtime");
    expect(py?.ledger).toEqual({ ok: 0, empty: 0, pending: 0, failed_retrying: 0, failed_terminal: 0 });
  });

  it("case 4: every source has a last_warning property", async () => {
    await env.DB.prepare("UPDATE sources SET last_warning = 'fixture: warn' WHERE id = 'kev'").run();
    const sources = await statusJson();
    expect(sources.length).toBe(7);
    for (const s of sources) expect(s, s.id).toHaveProperty("last_warning");
    expect(sources.find((s) => s.id === "kev")).toHaveProperty("last_warning", "fixture: warn");
    expect(sources.find((s) => s.id === "osv")).toHaveProperty("last_warning", null);
  });

  it("case 5: the grouped read uses idx_python_runtime_records_state_next on 2,000 rows (no ANALYZE)", async () => {
    await seedLedger("c5", { ok: 1200, empty: 300, pending: 200, retrying: 200, terminal: 100 });
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${ledgerSql("python_runtime_records")}`).all<{ detail: string }>();
    const p = results.map((r) => r.detail).join("\n");
    expect(p).toContain("idx_python_runtime_records_state_next");
    expect(p).not.toMatch(/SCAN python_runtime_records(?! USING)/);
    expect(p).not.toContain("TEMP B-TREE");
  });

  it("case 7: the home loader (no option) makes no ledger read", async () => {
    await seedLedger("c7", CASE1);
    const data = await loadStatus(env.DB);
    expect(data.sources.length).toBe(7);
    for (const s of data.sources) expect(s, s.id).not.toHaveProperty("ledger");
  });
});

describe("GET /status ledger sub-row", () => {
  it("case 6: python-runtime has a plain-text sub-row with the counts; osv has none", async () => {
    await seedLedger("c6", CASE1);
    const res = await get("/status", ip);
    expect(res.status).toBe(200);
    const html = await res.text();
    const py = html.match(/<td>python-runtime<\/td>[\s\S]*?<\/tr>\s*(<tr class="sub">[\s\S]*?<\/tr>)/);
    expect(py, "python-runtime sub-row").not.toBeNull();
    const sub = py![1];
    for (const t of ["ok 3", "empty 1", "pending 2", "failed, retrying 2", "failed, terminal 1"]) expect(sub).toContain(t);
    expect(sub).not.toContain("<a");
    const osv = html.match(/<td>osv<\/td>[\s\S]*?<\/tr>\s*(<tr[^>]*>)/);
    expect(osv, "row after osv").not.toBeNull();
    expect(osv![1]).not.toContain('class="sub"');
  });

  it("case 8: a source with a last_warning gets an escaped warning sub-row", async () => {
    await env.DB.prepare("UPDATE sources SET last_warning = 'fixture: <b>x</b>' WHERE id = 'kev'").run();
    const html = await (await get("/status", ip)).text();
    const kev = html.match(/<td>kev<\/td>[\s\S]*?<\/tr>\s*(<tr class="sub">[\s\S]*?<\/tr>)/);
    expect(kev, "kev sub-row").not.toBeNull();
    expect(kev![1]).toContain("last warning: fixture: &lt;b&gt;x&lt;/b&gt;");
    expect(kev![1]).not.toContain("ledger:");
  });
});
