import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../action/check.mjs";
import { API, json, world, type Call, type World } from "./helpers.tcs-33.js";

// TCS-101: after a check result, the Action posts the badge report with the
// workflow's OIDC token. Driven through run(io), the production entry. The
// fake fetch answers only the fake token service and the fake Tocsin API;
// any other URL throws.

const FIXTURE = new URL("../fixtures/cli/package-lock.json", import.meta.url);
const TOKEN_URL = "https://token.github.test/x?api-version=2.0";
const REQUEST_TOKEN = "req-token-fixture";
const JWT = "eyJfixture.jwt-value-fixture.sig";

const AFFECTED = {
  dependency: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
  advisory_id: "tcs_01JA0000000000000000000101",
  severity: { score: 7.2, label: "high" },
  exploited: false,
  fixed_in: "4.17.21",
  action: "Upgrade lodash to 4.17.21 or later.",
  url: "https://example.com/fixture/lodash",
};
const CLEAN = { checked: 2, affected: [], skipped: [], feed_cursor: 9 };
const DIRTY = { checked: 2, affected: [AFFECTED], skipped: [], feed_cursor: 9 };

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

interface Setup {
  answer?: unknown;
  event?: string;
  payload?: unknown;
  idToken?: boolean;
  inputs?: Record<string, string>;
  repository?: Record<string, unknown>;
  report?: () => Response;
}

async function setup(o: Setup = {}): Promise<{ w: World; fetch: (url: string, init?: RequestInit) => Promise<Response> }> {
  w = await world({ event: o.event ?? "push", inputs: o.inputs });
  const ww = w;
  await copyFile(FIXTURE, join(ww.dir, "package-lock.json"));
  await writeFile(ww.env.GITHUB_EVENT_PATH, JSON.stringify(o.payload ?? { repository: { full_name: "acme/widget", private: false, default_branch: "main", ...o.repository } }));
  ww.check = () => json(o.answer ?? CLEAN);
  if (o.idToken !== false) {
    ww.env.ACTIONS_ID_TOKEN_REQUEST_URL = TOKEN_URL;
    ww.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = REQUEST_TOKEN;
  }
  const report = o.report ?? (() => json({ recorded: true }));
  const fetch = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init.headers as HeadersInit)) headers[k.toLowerCase()] = v;
    const call: Call = { method: init.method ?? "GET", url: u, headers, body: init.body };
    if (u.origin === "https://token.github.test" && u.pathname === "/x") {
      ww.calls.push(call);
      return json({ value: JWT });
    }
    if (u.origin === API && call.method === "POST" && u.pathname === "/v1/action/report") {
      ww.calls.push(call);
      return report();
    }
    return ww.fetch(url, init);
  };
  return { w: ww, fetch };
}

const exec = (s: { w: World; fetch: (url: string, init?: RequestInit) => Promise<Response> }) => run({ env: s.w.env, fetch: s.fetch, out: s.w.out });
const tokenCalls = (w: World) => w.calls.filter((c) => c.url.origin === "https://token.github.test");
const reportCalls = (w: World) => w.calls.filter((c) => c.url.pathname === "/v1/action/report");

describe("the Action's badge report", () => {
  it("T1: requests the OIDC token for the API host and POSTs the report with it", async () => {
    const s = await setup({ answer: DIRTY, inputs: { TOCSIN_FAIL_ON: "never" } });
    expect(await exec(s)).toBe(0);
    const [tok] = tokenCalls(s.w);
    expect(tok).toBeDefined();
    expect(tok.url.searchParams.get("audience")).toBe("api.tocsin.test");
    expect(tok.url.searchParams.get("api-version")).toBe("2.0");
    expect(tok.headers.authorization).toBe(`Bearer ${REQUEST_TOKEN}`);
    const [rep] = reportCalls(s.w);
    expect(rep).toBeDefined();
    expect(rep.headers.authorization).toBe(`Bearer ${JWT}`);
    expect(rep.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(rep.body))).toEqual({ repository: "acme/widget", affected: 1, min_severity: "low", default_branch: "main" });
  });

  it("T2: the count is the one at or above min-severity", async () => {
    const s = await setup({ answer: DIRTY, inputs: { TOCSIN_MIN_SEVERITY: "critical" } });
    expect(await exec(s)).toBe(0);
    expect(JSON.parse(String(reportCalls(s.w)[0].body))).toMatchObject({ affected: 0, min_severity: "critical" });
  });

  it("T3: a 500 from the API is a warning and exit 0; with 1 affected and fail-on affected the exit stays 1", async () => {
    const s = await setup({ report: () => json({ error: "internal error" }, 500) });
    expect(await exec(s)).toBe(0);
    expect(s.w.stdout.filter((l) => l.startsWith("::warning title=tocsin::could not send the badge report"))).toHaveLength(1);
    expect(s.w.stdout.join("\n")).toContain("500 internal error");
    await w?.cleanup();
    const s2 = await setup({ answer: DIRTY, report: () => json({ error: "internal error" }, 500) });
    expect(await exec(s2)).toBe(1);
    expect(s2.w.stdout.some((l) => l.startsWith("::warning title=tocsin::could not send the badge report"))).toBe(true);
  });

  it("T4: a network error on the report is a warning, never a failure", async () => {
    const s = await setup({
      report: () => {
        throw new Error("fixture: connection reset");
      },
    });
    expect(await exec(s)).toBe(0);
    expect(s.w.stdout.some((l) => l.startsWith("::warning title=tocsin::could not send the badge report"))).toBe(true);
  });

  it("T5: report: false makes no token request", async () => {
    const s = await setup({ inputs: { TOCSIN_REPORT: "false" } });
    expect(await exec(s)).toBe(0);
    expect(tokenCalls(s.w)).toHaveLength(0);
    expect(reportCalls(s.w)).toHaveLength(0);
  });

  it("T6: no ACTIONS_ID_TOKEN_* makes no request and adds no stdout line", async () => {
    const s = await setup({ idToken: false });
    expect(await exec(s)).toBe(0);
    expect(tokenCalls(s.w)).toHaveLength(0);
    expect(reportCalls(s.w)).toHaveLength(0);
    expect(s.w.stdout).toEqual([]);
  });

  it("T7: a private repository makes no request", async () => {
    const s = await setup({ repository: { private: true } });
    expect(await exec(s)).toBe(0);
    expect(tokenCalls(s.w)).toHaveLength(0);
    expect(reportCalls(s.w)).toHaveLength(0);
  });

  it("T8: the JWT never appears in stdout, even on an error answer", async () => {
    const s = await setup({ report: () => json({ error: `bad ${JWT}` }, 401) });
    expect(await exec(s)).toBe(0);
    expect(s.w.stdout.join("\n")).not.toContain(JWT);
    expect(s.w.stdout.join("\n")).not.toContain(REQUEST_TOKEN);
  });

  it("T9: a check that could not run sends no report", async () => {
    const s = await setup();
    s.w.check = () => json({ error: "fixture down" }, 503);
    expect(await exec(s)).toBe(0);
    expect(tokenCalls(s.w)).toHaveLength(0);
  });

  it("T10: report must be true or false", async () => {
    const s = await setup({ inputs: { TOCSIN_REPORT: "maybe" } });
    expect(await exec(s)).toBe(1);
    expect(s.w.stdout[0]).toMatch(/^::error title=tocsin::invalid input: report: expected true or false/);
  });

  it("T11: a schedule run whose payload has no repository sends GITHUB_REF's branch as the default branch", async () => {
    const s = await setup({ event: "schedule", payload: { schedule: "17 5 * * *" } });
    s.w.env.GITHUB_REF = "refs/heads/trunk";
    expect(await exec(s)).toBe(0);
    expect(JSON.parse(String(reportCalls(s.w)[0].body))).toMatchObject({ default_branch: "trunk" });
  });

  it("T12: a push run whose payload has no repository sends default_branch null, not GITHUB_REF", async () => {
    const s = await setup({ payload: {} });
    s.w.env.GITHUB_REF = "refs/heads/feature";
    expect(await exec(s)).toBe(0);
    expect(JSON.parse(String(reportCalls(s.w)[0].body))).toMatchObject({ default_branch: null });
  });
});
