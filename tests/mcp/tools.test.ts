import { describe, expect, it } from "vitest";
import { TocsinApi, type FetchLike } from "../../workers/mcp/src/api";
import { check, get, latest, watchlistEvents, type ToolResult } from "../../workers/mcp/src/tools";
import fixture from "../fixtures/advisory/valid.json";

// The Tocsin API is faked with an injected fetch. Each test builds its own
// fake, so no test shares state or depends on order. 0 real network calls.

const BASE = "https://api-fixture.tocsin.test";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fakeApi(route: Route, base = BASE): { api: TocsinApi; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body });
    return route(url, init);
  };
  return { api: new TocsinApi(base, fetchFn), calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

function advisory(id: string, over: Record<string, unknown> = {}) {
  return { ...structuredClone(fixture), id, ...over };
}

function expectOneLine(r: ToolResult) {
  expect(typeof r.human).toBe("string");
  expect(r.human.length).toBeGreaterThan(0);
  expect(r.human).not.toMatch(/[\r\n]/);
  expect(r.data).toBeDefined();
}

const notFound = () => json({ error: "not found" }, 404);

describe("tocsin_latest", () => {
  it("returns the events newest first and a one-line human", async () => {
    const events = [
      advisory("tcs_01JC0000000000000000000003", { component: "next", severity: { score: 9.8, label: "critical" }, exploited: true }),
      advisory("tcs_01JC0000000000000000000002"),
      advisory("tcs_01JC0000000000000000000001"),
    ];
    const { api, calls } = fakeApi((url) =>
      url.pathname === "/v1/events" ? json({ events, next_cursor: 903, has_more: true }) : notFound(),
    );

    const r = await latest(api, {});

    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.searchParams.get("order")).toBe("desc");
    expect(u.searchParams.get("limit")).toBe("10");
    expect(r.isError).toBe(false);
    expectOneLine(r);
    const data = r.data as { events: { id: string }[]; next_cursor: number; has_more: boolean };
    expect(data.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(data.next_cursor).toBe(903);
    expect(data.has_more).toBe(true);
    expect(r.human).toContain("3 advisories");
    expect(r.human).toContain("tcs_01JC0000000000000000000003");
    expect(r.human).toContain("next critical, exploited");
  });

  it("maps every filter onto the feed query", async () => {
    const { api, calls } = fakeApi(() => json({ events: [], next_cursor: 0, has_more: false }));
    await latest(api, { ecosystem: "node", min_severity: "high", exploited_only: true, limit: 5 });
    const u = new URL(calls[0].url);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      order: "desc",
      limit: "5",
      ecosystem: "node",
      min_severity: "high",
      exploited: "true",
    });
  });

  it("says no advisories match on an empty 200", async () => {
    const { api } = fakeApi(() => json({ events: [], next_cursor: 0, has_more: false }));
    const r = await latest(api, { ecosystem: "eco-none" });
    expect(r.isError).toBe(false);
    expect(r.human).toBe("No advisories match these filters.");
  });
});

describe("tocsin_check", () => {
  it("runtimes {node:24.22.0} sends one JSON POST and returns one affected item", async () => {
    const affected = [
      {
        dependency: { ecosystem: "node", name: "node", version: "24.22.0" },
        advisory_id: fixture.id,
        cve_ids: fixture.cve_ids,
        severity: fixture.severity,
        exploited: false,
        fixed_in: "24.22.1",
        action: fixture.action,
        url: `${BASE}/v1/events/${fixture.id}`,
      },
    ];
    const { api, calls } = fakeApi((url, init) =>
      url.pathname === "/v1/check" && init.method === "POST"
        ? json({ checked: 1, affected, skipped: [], feed_cursor: 77 })
        : notFound(),
    );

    const r = await check(api, { runtimes: { node: "24.22.0" } });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0].body))).toEqual({ runtimes: { node: "24.22.0" } });
    expect(r.isError).toBe(false);
    expectOneLine(r);
    const data = r.data as { affected: unknown[]; checked: number };
    expect(data.affected).toHaveLength(1);
    expect(r.human.startsWith("1 of 1 dependencies affected")).toBe(true);
    expect(r.human).toContain("node 24.22.0: Upgrade node to 24.22.1 or later.");
  });

  it("sends a lockfile as multipart with the file name as the field name", async () => {
    const { api, calls } = fakeApi(() => json({ checked: 2, affected: [], skipped: [], feed_cursor: 5 }));
    const text = '{"lockfileVersion":3,"packages":{}}';
    const r = await check(api, { lockfile_name: "package-lock.json", lockfile_text: text });
    expect(calls).toHaveLength(1);
    const form = calls[0].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("package-lock.json");
    expect(file).not.toBeNull();
    expect(typeof file === "string" ? file : await (file as File).text()).toBe(text);
    expect(r.isError).toBe(false);
    expect(r.human).toBe("No known advisory affects the 2 checked dependencies.");
  });

  it("lockfile + runtimes: two calls in parallel, merged, feed_cursor is the lower one", async () => {
    const { api, calls } = fakeApi((_url, init) =>
      init.body instanceof FormData
        ? json({ checked: 3, affected: [{ advisory_id: "a-lock", dependency: { name: "lodash", version: "4.17.0" }, action: "Upgrade lodash." }], skipped: [{ file: "package-lock.json", reason: "x" }], feed_cursor: 40 })
        : json({ checked: 1, affected: [{ advisory_id: "a-rt", dependency: { name: "node", version: "24.22.0" }, action: "Upgrade node." }], skipped: [], feed_cursor: 39 }),
    );
    const r = await check(api, { lockfile_name: "package-lock.json", lockfile_text: "{}", runtimes: { node: "24.22.0" } });
    expect(calls).toHaveLength(2);
    const data = r.data as { checked: number; affected: { advisory_id: string }[]; skipped: unknown[]; feed_cursor: number };
    expect(data.checked).toBe(4);
    expect(data.affected.map((a) => a.advisory_id)).toEqual(["a-lock", "a-rt"]);
    expect(data.skipped).toHaveLength(1);
    expect(data.feed_cursor).toBe(39);
    expect(r.human).toBe("2 of 4 dependencies affected. Worst: lodash 4.17.0: Upgrade lodash. 1 skipped.");
  });

  it("refuses an empty call and a lockfile without a name, with no HTTP call", async () => {
    const { api, calls } = fakeApi(() => json({}));
    const none = await check(api, {});
    expect(none.isError).toBe(true);
    const noName = await check(api, { lockfile_text: "{}" });
    expect(noName.isError).toBe(true);
    expectOneLine(noName);
    expect(calls).toHaveLength(0);
  });
});

describe("tocsin_get", () => {
  it('"CVE-2026-111497" resolves by CVE', async () => {
    const { api, calls } = fakeApi((url) =>
      url.pathname === "/v1/events/cve/CVE-2026-111497" ? json(fixture) : notFound(),
    );
    const r = await get(api, { id_or_cve: "CVE-2026-111497" });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/events/cve/CVE-2026-111497"]);
    expect(r.isError).toBe(false);
    expectOneLine(r);
    expect((r.data as { id: string }).id).toBe(fixture.id);
    expect(r.human).toBe(`${fixture.id} (CVE-2026-111497) node high: Upgrade node to 24.22.1 or later.`);
  });

  it("routes CVE vs id by the exact CVE shape", async () => {
    const { api, calls } = fakeApi(() => json(fixture));
    await get(api, { id_or_cve: " cve-2026-111497 " });
    await get(api, { id_or_cve: "GHSA-fixt-ure0-0001" });
    await get(api, { id_or_cve: "CVE-2026-1" });
    await get(api, { id_or_cve: "xCVE-2026-111497" });
    await get(api, { id_or_cve: "CVE-2026-111497/../keys" });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v1/events/cve/CVE-2026-111497",
      "/v1/events/GHSA-fixt-ure0-0001",
      "/v1/events/CVE-2026-1",
      "/v1/events/xCVE-2026-111497",
      "/v1/events/CVE-2026-111497%2F..%2Fkeys",
    ]);
  });

  it("answers isError on 404", async () => {
    const { api } = fakeApi(() => notFound());
    const r = await get(api, { id_or_cve: "tcs_missing" });
    expect(r.isError).toBe(true);
    expect(r.human).toBe("No advisory found for tcs_missing.");
  });
});

describe("tocsin_watchlist_events", () => {
  it("with no bearer answers isError and makes no HTTP call", async () => {
    const { api, calls } = fakeApi(() => json({ events: [] }));
    const r = await watchlistEvents(api, { watchlist_id: "wl_1" }, null);
    expect(r.isError).toBe(true);
    expectOneLine(r);
    expect(r.human).toContain("Authorization: Bearer");
    expect(calls).toHaveLength(0);
  });

  it("sends the bearer on the watch-list call, and only there", async () => {
    const { api, calls } = fakeApi((url) => {
      if (url.pathname === "/v1/watchlists/wl_1/events") return json({ events: [advisory("tcs_01JC0000000000000000000009")], next_cursor: 9, has_more: false });
      if (url.pathname === "/v1/events") return json({ events: [], next_cursor: 0, has_more: false });
      if (url.pathname === "/v1/check") return json({ checked: 0, affected: [], skipped: [], feed_cursor: 0 });
      return json(fixture);
    });
    const r = await watchlistEvents(api, { watchlist_id: "wl_1" }, "tcs_fixture_key");
    await latest(api, {});
    await check(api, { runtimes: { node: "24.22.0" } });
    await get(api, { id_or_cve: "CVE-2026-111497" });

    expect(r.isError).toBe(false);
    expect(r.human).toBe("1 new event on watch list wl_1. Newest: tcs_01JC0000000000000000000009 node high.");
    expect(calls).toHaveLength(4);
    expect(calls[0].headers.get("authorization")).toBe("Bearer tcs_fixture_key");
    for (const c of calls.slice(1)) expect(c.headers.get("authorization")).toBeNull();
  });
});

describe("API errors are never a success", () => {
  const cases: [string, () => Response | never][] = [
    ["404", () => json({ error: "not found" }, 404)],
    ["429", () => json({ error: "rate limited" }, 429, { "Retry-After": "30" })],
    ["500", () => json({ error: "boom" }, 500)],
    ["network", () => {
      throw new TypeError("network down");
    }],
  ];
  for (const [name, respond] of cases) {
    it(`${name} → isError on every tool`, async () => {
      const { api } = fakeApi(() => respond());
      const results = [
        await latest(api, {}),
        await check(api, { runtimes: { node: "24.22.0" } }),
        await get(api, { id_or_cve: "tcs_x" }),
        await watchlistEvents(api, { watchlist_id: "wl_1" }, "tcs_fixture_key"),
      ];
      for (const r of results) {
        expect(r.isError).toBe(true);
        expectOneLine(r);
        expect(r.human).not.toContain("No known advisory");
        expect(r.human).not.toContain("No advisories match");
        if (name !== "404" || r !== results[2]) expect(r.human).toContain(name === "network" ? "network down" : `answered ${name}`);
      }
      if (name === "429") expect(results[0].human).toContain("Retry after 30 s");
    });
  }
});

describe("TocsinApi base URL", () => {
  it("builds every URL on the configured host", async () => {
    const { api, calls } = fakeApi(() => json({ events: [], checked: 0, affected: [], skipped: [], feed_cursor: 0 }), "https://self.example/");
    await latest(api, {});
    await check(api, { runtimes: { node: "24.22.0" } });
    await get(api, { id_or_cve: "CVE-2026-111497" });
    await get(api, { id_or_cve: "tcs_x" });
    await watchlistEvents(api, { watchlist_id: "wl 1" }, "tcs_fixture_key");
    expect(calls).toHaveLength(5);
    for (const c of calls) expect(c.url.startsWith("https://self.example/v1/")).toBe(true);
    expect(new URL(calls[4].url).pathname).toBe("/v1/watchlists/wl%201/events");
  });
});
