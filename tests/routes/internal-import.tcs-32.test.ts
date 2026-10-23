import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { osvRecord } from "../backfill/zip-fixture.tcs-32";

// POST/GET /v1/internal/import through the production worker (src/index.ts).
// Each call passes its own env, so a test sets or unsets IMPORT_TOKEN without
// a test flag: the route is a real route, present in prod and bearer-gated.
const TOKEN = "tok-fixture-import-32";
const URL_BASE = "https://tocsin.test/v1/internal/import";

async function call(path: string, init: RequestInit & { token?: string | null; envToken?: string | null } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set("Authorization", `Bearer ${init.token ?? TOKEN}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const e = { ...env } as typeof env & { IMPORT_TOKEN?: string };
  if (init.envToken === null) delete e.IMPORT_TOKEN;
  else e.IMPORT_TOKEN = init.envToken ?? TOKEN;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${URL_BASE}${path}`, { method: init.method, headers, body: init.body }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const post = (body: unknown, opts: { token?: string | null; envToken?: string | null } = {}) =>
  call("", { method: "POST", body: JSON.stringify(body), ...opts });

interface Answer {
  ecosystem: string;
  imported: number;
  unchanged: number;
  skipped: number;
  inserted: number;
  updated: number;
  errors: string[];
  last_id: string;
  done_at: string | null;
}

const row = (eco: string) =>
  env.DB.prepare("SELECT * FROM backfill WHERE ecosystem = ?").bind(eco).first<{
    started_at: string | null;
    done_at: string | null;
    imported: number;
    unchanged: number;
    skipped: number;
    last_id: string | null;
    coverage_since: string | null;
  }>();
const osvCoverage = async () => (await env.DB.prepare("SELECT coverage_since FROM sources WHERE id = 'osv'").first<{ coverage_since: string | null }>())!.coverage_since;

beforeEach(async () => {
  // Two enabled OSV ecosystems for this file; the osv row is restored after each test.
  await env.DB.prepare("UPDATE sources SET config_json = ?, coverage_since = NULL WHERE id = 'osv'").bind(JSON.stringify({ ecosystems: ["npm", "PyPI"] })).run();
  await env.DB.prepare("DELETE FROM backfill").run();
});
afterEach(async () => {
  await env.DB.prepare("UPDATE sources SET config_json = '{}', coverage_since = NULL WHERE id = 'osv'").run();
  await env.DB.prepare("DELETE FROM settings WHERE key = 'import.max_batch'").run();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('import.max_batch', '100')").run();
});

const batch = (ids: string[], over: Record<string, unknown> = {}) => ({
  ecosystem: "npm",
  records: ids.map((id) => osvRecord(id, "npm", `tcs32-${id.toLowerCase()}`)),
  skipped: 0,
  last_id: ids[ids.length - 1] ?? "GHSA-0000-0000-0000",
  ...over,
});

describe("auth (fail closed, before the body is read)", () => {
  it("no bearer -> 401, not 404: the route exists with no test flag", async () => {
    const res = await post(batch(["GHSA-aaaa-0000-0001"]), { token: null });
    expect(res.status).toBe(401);
    const get = await call("/npm", { token: null });
    expect(get.status).toBe(401);
  });

  it("wrong bearer -> 403", async () => {
    expect((await post(batch(["GHSA-aaaa-0000-0001"]), { token: "tok-fixture-wrong" })).status).toBe(403);
    expect((await call("/npm", { token: "tok-fixture-wrong" })).status).toBe(403);
  });

  it("IMPORT_TOKEN unset -> 403, even with a bearer", async () => {
    expect((await post(batch(["GHSA-aaaa-0000-0001"]), { envToken: null })).status).toBe(403);
    expect((await post(batch(["GHSA-aaaa-0000-0001"]), { envToken: null, token: "" })).status).toBe(403);
    expect(await row("npm")).toBeNull();
  });

  it("a secret with a trailing newline still matches (trim on both sides)", async () => {
    const res = await post(batch(["GHSA-aaaa-0000-0002"]), { envToken: `${TOKEN}\n` });
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

describe("limits", () => {
  it("101 records (the seeded import.max_batch is 100) -> 413 and nothing is written", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `GHSA-bbbb-0000-${String(i).padStart(4, "0")}`);
    const res = await post(batch(ids));
    expect(res.status).toBe(413);
    expect(await row("npm")).toBeNull();
  });

  it("the 413 follows settings import.max_batch (10)", async () => {
    await env.DB.prepare("UPDATE settings SET value = '10' WHERE key = 'import.max_batch'").run();
    const ids = Array.from({ length: 11 }, (_, i) => `GHSA-cccc-0000-${String(i).padStart(4, "0")}`);
    expect((await post(batch(ids))).status).toBe(413);
    expect((await post(batch(ids.slice(0, 10)))).status).toBe(200);
    const get = (await (await call("/npm")).json()) as { max_batch: number };
    expect(get.max_batch).toBe(10);
  });

  it("an ecosystem that is not in the osv config (Maven) -> 400", async () => {
    expect((await post(batch(["GHSA-dddd-0000-0001"], { ecosystem: "Maven" }))).status).toBe(400);
    expect((await call("/Maven")).status).toBe(400);
  });

  it("a body that is not the import shape -> 400", async () => {
    expect((await post({ ecosystem: "npm", records: "x", skipped: 0, last_id: "a" })).status).toBe(400);
    expect((await post({ ecosystem: "npm", records: [], skipped: -1, last_id: "a" })).status).toBe(400);
    expect((await post({ ecosystem: "npm", records: [], skipped: 0 })).status).toBe(400);
  });
});

describe("import", () => {
  it("writes advisories with the cron's normalizeOsv/upsertAdvisory, skips MAL- and withdrawn, and moves the backfill row", async () => {
    const records = [
      osvRecord("GHSA-eeee-0000-0001", "npm", "tcs32-e1", { published: "2019-05-01T00:00:00Z" }),
      osvRecord("GHSA-eeee-0000-0002", "npm", "tcs32-e2", { published: "2021-01-01T00:00:00Z" }),
      osvRecord("GHSA-eeee-0000-0003", "npm", "tcs32-e3", { withdrawn: true }),
      osvRecord("MAL-2026-0001", "npm", "tcs32-mal"),
      osvRecord("GHSA-eeee-0000-0004", "Maven", "tcs32-maven"),
    ];
    const res = await post({ ecosystem: "npm", records, skipped: 3, last_id: "MAL-2026-0001", start: true });
    expect(res.status, await res.clone().text()).toBe(200);
    const a = (await res.json()) as Answer;
    expect(a.imported).toBe(2);
    expect(a.inserted).toBe(2);
    expect(a.unchanged).toBe(0);
    // TCS-71: the Maven record (Maven is not enabled) is skipped as ecosystem_not_enabled, not an error.
    expect(a.skipped).toBe(6);
    expect((a as Answer & { skipped_reasons: Record<string, number> }).skipped_reasons).toEqual({ ecosystem_not_enabled: 1 });
    expect(a.errors).toEqual([]);
    expect(a.done_at).toBeNull();

    const doc = await env.DB.prepare(
      "SELECT a.doc_json FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id = 'GHSA-eeee-0000-0001'",
    ).first<{ doc_json: string }>();
    const parsed = JSON.parse(doc!.doc_json) as { ecosystem: string; component: string; action: string; published_at: string };
    expect(parsed.ecosystem).toBe("npm");
    expect(parsed.component).toBe("tcs32-e1");
    expect(parsed.action).toBe("Upgrade tcs32-e1 to 1.0.1 or later.");
    const skippedRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisory_sources WHERE source_id IN ('GHSA-eeee-0000-0003', 'MAL-2026-0001', 'GHSA-eeee-0000-0004')").first<{ n: number }>();
    expect(skippedRows!.n).toBe(0);

    const r = await row("npm");
    expect(r).toMatchObject({ imported: 2, unchanged: 0, skipped: 6, last_id: "MAL-2026-0001", done_at: null, coverage_since: "2019-05-01T00:00:00Z" });
    expect(r!.started_at).not.toBeNull();
  });

  it("a replayed batch (same last_id) writes nothing new and does not count twice", async () => {
    const b = batch(["GHSA-ffff-0000-0001", "GHSA-ffff-0000-0002"], { start: true });
    expect((await post(b)).status).toBe(200);
    const again = (await (await post({ ...b, start: undefined })).json()) as Answer;
    expect(again.unchanged).toBe(2);
    expect(again.imported).toBe(0);
    expect(await row("npm")).toMatchObject({ imported: 2, unchanged: 0 });
  });

  it("final sets done_at; sources.osv.coverage_since is set only when every enabled ecosystem is done", async () => {
    await post({ ...batch(["GHSA-gggg-0000-0001"]), records: [osvRecord("GHSA-gggg-0000-0001", "npm", "tcs32-g1", { published: "2018-03-01T00:00:00Z" })], final: true, start: true });
    expect((await row("npm"))!.done_at).not.toBeNull();
    expect(await osvCoverage()).toBeNull();

    const py = await post({
      ecosystem: "PyPI",
      records: [osvRecord("PYSEC-2017-1", "PyPI", "tcs32-py", { published: "2017-06-01T00:00:00Z" })],
      skipped: 0,
      last_id: "PYSEC-2017-1",
      final: true,
      start: true,
    });
    expect(py.status).toBe(200);
    expect(((await py.json()) as Answer).done_at).not.toBeNull();
    expect(await osvCoverage()).toBe("2017-06-01T00:00:00Z");
  });

  it("a restart (start: true) after done keeps done_at and resets the counters", async () => {
    await post({ ...batch(["GHSA-hhhh-0000-0001"]), final: true, start: true });
    const done = (await row("npm"))!.done_at;
    await post({ ...batch(["GHSA-hhhh-0000-0001"]), start: true });
    expect(await row("npm")).toMatchObject({ done_at: done, imported: 0, unchanged: 1 });
  });

  it("an older zip copy never replaces a newer stored record; it counts as stale and unchanged", async () => {
    const id = "GHSA-prob-0000-0001";
    const newer = osvRecord(id, "npm", "tcs32-prob", { modified: "2026-10-22T00:00:00Z", fixed: "2.0.0" });
    const older = osvRecord(id, "npm", "tcs32-prob", { modified: "2026-10-01T00:00:00Z", fixed: "1.0.1" });
    const first = (await (await post({ ...batch([id]), records: [newer], start: true })).json()) as Answer;
    expect(first.inserted).toBe(1);

    const second = (await (await post({ ...batch([id]), records: [older], start: true })).json()) as Answer & { stale: number };
    expect(second).toMatchObject({ inserted: 0, updated: 0, stale: 1, imported: 0, unchanged: 1, errors: [] });
    expect(await row("npm")).toMatchObject({ imported: 0, unchanged: 1, coverage_since: "2020-01-01T00:00:00Z" });

    const stored = await env.DB.prepare("SELECT a.modified_at, a.doc_json FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id = ?")
      .bind(id)
      .first<{ modified_at: string; doc_json: string }>();
    expect(stored!.modified_at).toBe("2026-10-22T00:00:00Z");
    expect(JSON.parse(stored!.doc_json).fixed_versions).toEqual(["2.0.0"]);
  });

  it("a zip copy with a later modified updates the stored record", async () => {
    const id = "GHSA-prob-0000-0002";
    await post({ ...batch([id]), records: [osvRecord(id, "npm", "tcs32-prob2", { modified: "2026-10-01T00:00:00Z", fixed: "1.0.1" })], start: true });
    const res = (await (await post({ ...batch([id]), records: [osvRecord(id, "npm", "tcs32-prob2", { modified: "2026-10-22T00:00:00Z", fixed: "2.0.0" })], start: true })).json()) as Answer & { stale: number };
    expect(res).toMatchObject({ updated: 1, stale: 0, imported: 1 });
    const stored = await env.DB.prepare("SELECT a.modified_at FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id = ?")
      .bind(id)
      .first<{ modified_at: string }>();
    expect(stored!.modified_at).toBe("2026-10-22T00:00:00Z");
  });

  it("GET returns the row (or a zero row) with max_batch and skip_id_prefixes", async () => {
    const zero = (await (await call("/npm")).json()) as Record<string, unknown>;
    expect(zero).toMatchObject({ ecosystem: "npm", last_id: null, done_at: null, imported: 0, max_batch: 100, skip_id_prefixes: ["MAL-"] });
    await post(batch(["GHSA-iiii-0000-0001"], { start: true }));
    const got = (await (await call("/npm")).json()) as Record<string, unknown>;
    expect(got).toMatchObject({ last_id: "GHSA-iiii-0000-0001", imported: 1 });
  });
});
