import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PY_ETAG_KEY, PY_TAGS_KEY } from "../../src/ingest/python-runtime";
import { defaultRegistry, runIngesters } from "../../src/ingest/registry";
import type { Ingester, RunResult } from "../../src/ingest/types";
import listingJson from "../fixtures/python-runtime/listing.json?raw";
import psf43 from "../fixtures/python-runtime/PSF-2026-43.json?raw";
import tagsJson from "../fixtures/python-runtime/tags.json?raw";
import { createPyFake } from "../ingest/python-fake.tcs-39";

// TCS-50: RunResult.warnings -> sources.last_warning, through runIngesters.
const NOW = new Date("2026-10-22T22:00:00Z");
const LATER = new Date("2026-10-22T23:00:00Z");

interface Row {
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_warning: string | null;
}

let seq = 0;
function uniq(tag: string): string {
  seq += 1;
  return `tcs50-${tag}-${seq}`;
}

// Disables every row, then enables only the stub source the case inserts.
async function onlyStub(id: string, lastError: string | null = null): Promise<void> {
  await env.DB.prepare("UPDATE sources SET enabled = 0").run();
  await env.DB.prepare("INSERT INTO sources (id, kind, enabled, config_json, last_error) VALUES (?, 'test', 1, '{}', ?)").bind(id, lastError).run();
}

async function row(id: string): Promise<Row> {
  const r = await env.DB.prepare("SELECT last_run_at, last_ok_at, last_error, last_warning FROM sources WHERE id = ?").bind(id).first<Row>();
  if (!r) throw new Error(`no source ${id}`);
  return r;
}

const stub = (id: string, result: RunResult): Record<string, Ingester> => ({ [id]: { id, run: async () => result } });
const result = (errors: string[], warnings?: string[]): RunResult => ({ fetched: 0, upserted: 0, unchanged: 0, errors, ...(warnings ? { warnings } : {}) });

let logSpy: MockInstance;
beforeAll(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  logSpy.mockRestore();
});

describe("runIngesters writes warnings to last_warning", () => {
  it("case 1: warnings and no errors -> ok, last_ok_at moves, last_error NULL, last_warning written", async () => {
    const id = uniq("warn");
    await onlyStub(id);
    const out = await runIngesters(env, stub(id, result([], ["fixture: warn one"])), () => NOW);
    expect(out).toEqual([expect.objectContaining({ source: id, status: "ok" })]);
    expect(await row(id)).toEqual({ last_run_at: NOW.toISOString(), last_ok_at: NOW.toISOString(), last_error: null, last_warning: "fixture: warn one" });
  });

  it("case 2: a warnings-only run clears an old last_error", async () => {
    const id = uniq("clear");
    await onlyStub(id, "fixture: old");
    await runIngesters(env, stub(id, result([], ["fixture: warn two"])), () => NOW);
    const r = await row(id);
    expect(r.last_error).toBeNull();
    expect(r.last_ok_at).toBe(NOW.toISOString());
    expect(r.last_warning).toBe("fixture: warn two");
  });

  it("case 3: a later run with no warnings keeps last_warning and moves last_ok_at", async () => {
    const id = uniq("keep");
    await onlyStub(id);
    await runIngesters(env, stub(id, result([], ["fixture: warn three"])), () => NOW);
    await runIngesters(env, stub(id, result([], [])), () => LATER);
    await runIngesters(env, stub(id, result([])), () => LATER);
    const r = await row(id);
    expect(r.last_ok_at).toBe(LATER.toISOString());
    expect(r.last_warning).toBe("fixture: warn three");
  });

  it("case 4: errors and warnings -> failed, last_error and last_warning set, last_ok_at unchanged", async () => {
    const id = uniq("both");
    await onlyStub(id);
    await runIngesters(env, stub(id, result([])), () => NOW);
    const out = await runIngesters(env, stub(id, result(["fixture: bad record"], ["fixture: warn four"])), () => LATER);
    expect(out).toEqual([expect.objectContaining({ source: id, status: "failed" })]);
    const r = await row(id);
    expect(r.last_error).toContain("fixture: bad record");
    expect(r.last_warning).toBe("fixture: warn four");
    expect(r.last_ok_at).toBe(NOW.toISOString());
    expect(r.last_run_at).toBe(LATER.toISOString());
  });

  it("case 5: a 2,000-char warning is stored cut to 1,000 chars", async () => {
    const id = uniq("long");
    await onlyStub(id);
    await runIngesters(env, stub(id, result([], ["w".repeat(2000)])), () => NOW);
    expect((await row(id)).last_warning).toBe("w".repeat(1000));
  });
});

describe("python-runtime terminal note is a warning", () => {
  const LISTING = "https://api.github.com/repos/psf/advisory-database/contents/advisories/python";
  const TAGS = "https://api.github.com/repos/python/cpython/git/matching-refs/tags/v3.";
  const REC43 = "https://raw.githubusercontent.com/psf/advisory-database/main/advisories/python/PSF-2026-43.json";
  const CVE19445 = "https://cveawg.mitre.org/api/cve/CVE-2026-19445";
  let fetchSpy: MockInstance;

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM python_runtime_records").run();
    await env.CURSORS.delete(PY_ETAG_KEY);
    await env.CURSORS.delete(PY_TAGS_KEY);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  it("case 6: the tenth failed attempt -> outcome ok, last_error NULL, last_warning holds the note", async () => {
    // Every listed id except PSF-2026-43 is already handled; PSF-2026-43 is at 9 failed attempts and due.
    const listed = (JSON.parse(listingJson) as { name: string }[]).map((e) => e.name.replace(/\.json$/, "")).filter((n) => n !== "PSF-2026-43");
    const insert = env.DB.prepare("INSERT INTO python_runtime_records (psf_id, state, attempts, updated_at) VALUES (?, 'ok', 0, ?)");
    await env.DB.batch(listed.map((n) => insert.bind(n, NOW.toISOString())));
    await env.DB.prepare("INSERT INTO python_runtime_records (psf_id, state, attempts, last_error, next_check_at, updated_at) VALUES ('PSF-2026-43', 'failed', 9, 'PythonHttpError: 404', ?, ?)")
      .bind(NOW.toISOString(), NOW.toISOString())
      .run();
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id != 'python-runtime'").run();
    await env.DB.prepare("UPDATE sources SET enabled = 1, last_error = NULL, last_warning = NULL WHERE id = 'python-runtime'").run();
    const fake = createPyFake({
      [LISTING]: { body: listingJson },
      [REC43]: psf43,
      [CVE19445]: { status: 404, body: '{"error":"CVE_RECORD_DNE"}' },
      [TAGS]: { body: tagsJson },
    });
    fetchSpy.mockImplementation(fake.fetch as never);
    try {
      const out = await runIngesters(env, defaultRegistry, () => NOW);
      expect(out).toEqual([expect.objectContaining({ source: "python-runtime", status: "ok" })]);
      expect(fake.count(CVE19445)).toBe(1);
      const r = await row("python-runtime");
      expect(r.last_error).toBeNull();
      expect(r.last_ok_at).toBe(NOW.toISOString());
      expect(r.last_warning).toMatch(/^PSF-2026-43: failed terminally after 10 attempts/);
    } finally {
      fetchSpy.mockRestore();
      await env.DB.prepare("UPDATE sources SET enabled = 1").run();
    }
  });
});
