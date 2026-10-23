import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runCron } from "../../src/cron/run";
import worker from "../../src/index";
import { defaultRegistry } from "../../src/ingest/registry";
import type { Ingester, RunResult } from "../../src/ingest/types";

interface SourceStatus {
  id: string;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
}

let seq = 0;
function uniq(tag: string): string {
  seq += 1;
  return `tcs2-${tag}-${Date.now().toString(36)}-${seq}`;
}

const OK: RunResult = { fetched: 1, upserted: 1, unchanged: 0, errors: [] };

// Each test disables every row, then enables only the rows it inserts.
async function onlyEnabled(...ids: string[]): Promise<void> {
  await env.DB.prepare("UPDATE sources SET enabled = 0").run();
  for (const id of ids) {
    await env.DB.prepare("INSERT INTO sources (id, kind, enabled, config_json) VALUES (?, 'test', 1, '{}')").bind(id).run();
  }
}

async function status(id: string): Promise<SourceStatus> {
  const r = await env.DB.prepare("SELECT id, last_run_at, last_ok_at, last_error FROM sources WHERE id = ?").bind(id).first<SourceStatus>();
  if (!r) throw new Error(`no source ${id}`);
  return r;
}

function fakeIngester(id: string, impl: () => Promise<RunResult>): Ingester & { calls: number } {
  const ing = {
    id,
    calls: 0,
    async run() {
      ing.calls += 1;
      return impl();
    },
  };
  return ing;
}

async function cron(registry: Record<string, Ingester>): Promise<void> {
  const ctx = createExecutionContext();
  await runCron(createScheduledController({ cron: "*/10 * * * *", scheduledTime: Date.now() }), env, ctx, registry);
  await waitOnExecutionContext(ctx);
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("runCron with the ingest registry", () => {
  it("case 1: one failing and one passing ingester both run; last_error on the failing source only", async () => {
    const fail = uniq("fail");
    const pass = uniq("pass");
    await onlyEnabled(fail, pass);
    const failing = fakeIngester(fail, async () => {
      throw new Error("upstream 503");
    });
    const passing = fakeIngester(pass, async () => OK);
    // The failing ingester sorts first (ORDER BY id), so the passing one runs after a throw.
    expect(fail < pass).toBe(true);

    await cron({ [fail]: failing, [pass]: passing });

    expect(failing.calls).toBe(1);
    expect(passing.calls).toBe(1);
    const f = await status(fail);
    const p = await status(pass);
    expect(f.last_error).toContain("upstream 503");
    expect(f.last_ok_at).toBeNull();
    expect(f.last_run_at).not.toBeNull();
    expect(p.last_error).toBeNull();
    expect(p.last_ok_at).not.toBeNull();
    expect(p.last_run_at).not.toBeNull();
  });

  it("case 1b: a later success clears last_error; a later failure keeps the old last_ok_at", async () => {
    const id = uniq("flip");
    await onlyEnabled(id);
    await cron({ [id]: fakeIngester(id, async () => { throw new Error("first"); }) });
    await cron({ [id]: fakeIngester(id, async () => OK) });
    const ok = await status(id);
    expect(ok.last_error).toBeNull();
    expect(ok.last_ok_at).not.toBeNull();
    await cron({ [id]: fakeIngester(id, async () => { throw new Error("second"); }) });
    const after = await status(id);
    expect(after.last_error).toContain("second");
    expect(after.last_ok_at).toBe(ok.last_ok_at);
  });

  it("case 2: an ingester that returns errors gets last_error and no last_ok_at", async () => {
    const id = uniq("errs");
    await onlyEnabled(id);
    await cron({ [id]: fakeIngester(id, async () => ({ ...OK, errors: ["x"] })) });
    const s = await status(id);
    expect(s.last_error).toContain("x");
    expect(s.last_ok_at).toBeNull();
    expect(s.last_run_at).not.toBeNull();
  });

  it("case 2b: last_error is cut to 1000 chars", async () => {
    const id = uniq("long");
    await onlyEnabled(id);
    await cron({ [id]: fakeIngester(id, async () => { throw new Error("e".repeat(5000)); }) });
    expect((await status(id)).last_error!.length).toBe(1000);
  });

  it("case 3: an enabled row with no ingester stays untouched, and a disabled row is not run", async () => {
    const orphan = uniq("orphan");
    const disabled = uniq("disabled");
    await onlyEnabled(orphan, disabled);
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").bind(disabled).run();
    const off = fakeIngester(disabled, async () => OK);
    await cron({ [disabled]: off });
    expect(off.calls).toBe(0);
    expect(await status(orphan)).toEqual({ id: orphan, last_run_at: null, last_ok_at: null, last_error: null });
    expect(await status(disabled)).toEqual({ id: disabled, last_run_at: null, last_ok_at: null, last_error: null });
  });

  it("case 3b: the default registry has exactly the osv, nvd, kev, epss, node-runtime, node-eol, php-runtime, python-runtime, deno-runtime and bun-runtime ingesters", () => {
    expect(Object.keys(defaultRegistry).sort()).toEqual(["bun-runtime", "deno-runtime", "epss", "kev", "node-eol", "node-runtime", "nvd", "osv", "php-runtime", "python-runtime"]);
    for (const [key, ingester] of Object.entries(defaultRegistry)) expect(ingester.id).toBe(key);
  });

  it("case 4: worker.scheduled from src/index.ts runs the registry and makes 0 fetch calls when every source is disabled", async () => {
    await env.DB.prepare("UPDATE sources SET enabled = 0").run();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/10 * * * *", scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("case 4b: worker.scheduled runs the osv source through the default registry and records its failure", async () => {
    // The osv row points at a host the fake fetch refuses, so the run fails
    // and the status write proves src/index.ts reached the registry.
    await env.DB.prepare("UPDATE sources SET enabled = 0").run();
    await env.DB.prepare(
      "UPDATE sources SET enabled = 1, last_error = NULL, config_json = ? WHERE id = 'osv'",
    )
      .bind(JSON.stringify({ csv_base: "https://refused.invalid", api_base: "https://refused.invalid", ecosystems: ["npm"] }))
      .run();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("no", { status: 503 }));
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/10 * * * *", scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe("https://refused.invalid/npm/modified_id.csv");
    const s = await status("osv");
    expect(s.last_error).toContain("503");
    expect(s.last_ok_at).toBeNull();
  });
});
