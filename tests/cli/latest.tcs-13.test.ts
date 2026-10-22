import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { fakeIo, json, type FakeIo } from "./helpers.tcs-13.js";

const BASE_EVENT = JSON.parse(readFileSync(new URL("../fixtures/advisory/valid.json", import.meta.url), "utf8"));
const event = (n: number, extra: Record<string, unknown> = {}) => ({ ...BASE_EVENT, id: `tcs_01JA00000000000000000000E${n}`, ...extra });

let io: FakeIo | undefined;
afterEach(async () => {
  await io?.cleanup();
  io = undefined;
});

describe("tocsin latest", () => {
  it("one line per event", async () => {
    io = await fakeIo(["latest"]);
    const events = [event(1, { summary: "First line\nsecond line" }), event(2, { exploited: true }), event(3, { cve_ids: [] })];
    io.routes.push((c) => (c.url.pathname === "/v1/events" ? json({ events, next_cursor: 42, has_more: false }) : undefined));
    expect(await main(io)).toBe(0);
    const lines = io.text().out.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(3);
    lines.forEach((l, i) => expect(l).toContain(events[i].id));
    expect(lines[0]).toBe(`2026-10-20 high node/node ${events[0].id} CVE-2026-111497: First line second line`);
    expect(lines[1]).toContain(" exploited: ");
    expect(lines[2]).toBe(`2026-10-20 high node/node ${events[2].id}: ${BASE_EVENT.summary}`);
    expect(io.text().err).toContain("next_cursor: 42");
    expect(io.calls[0].url.searchParams.get("order")).toBe("desc");
    expect(io.calls[0].url.searchParams.get("limit")).toBe("20");
  });

  it("--json prints the raw page", async () => {
    io = await fakeIo(["latest", "--json", "--limit", "2"]);
    const page = { events: [event(1)], next_cursor: 9, has_more: true };
    io.routes.push(() => json(page));
    expect(await main(io)).toBe(0);
    expect(JSON.parse(io.text().out).next_cursor).toBe(9);
    expect(JSON.parse(io.text().out).events[0].id).toBe(event(1).id);
    expect(io.calls[0].url.searchParams.get("limit")).toBe("2");
  });

  it("query carries ecosystem and since", async () => {
    io = await fakeIo(["latest", "--ecosystem", "npm", "--since", "40"]);
    io.routes.push(() => json({ events: [], next_cursor: 40, has_more: false }));
    expect(await main(io)).toBe(0);
    const q = io.calls[0].url.searchParams;
    expect(q.get("ecosystem")).toBe("npm");
    expect(q.get("since")).toBe("40");
    expect(q.get("order")).toBe("desc");
  });

  it("bad since or limit exit 2", async () => {
    for (const argv of [["--since", "abc"], ["--since", "-1"], ["--limit", "0"], ["--limit", "101"], ["--limit", "x"]]) {
      io = await fakeIo(["latest", ...argv]);
      expect(await main(io)).toBe(2);
      expect(io.calls).toHaveLength(0);
      await io.cleanup();
    }
    io = undefined;
  });

  it("an API failure exits 3", async () => {
    io = await fakeIo(["latest"]);
    io.routes.push(() => json({ error: "rate limited" }, 429, { "Retry-After": "30" }));
    expect(await main(io)).toBe(3);
    expect(io.text().err).toContain("429 rate limited");
    expect(io.text().out).toBe("");
  });

  it("api key header", async () => {
    io = await fakeIo(["latest"], { TOCSIN_API_KEY: "tcs_fixture_key" });
    io.routes.push(() => json({ events: [event(1)], next_cursor: 1, has_more: false }));
    expect(await main(io)).toBe(0);
    expect(io.calls[0].headers.authorization).toBe("Bearer tcs_fixture_key");
    expect(io.calls[0].headers["user-agent"]).toMatch(/^tocsin-cli\//);
    const { out, err } = io.text();
    expect(out + err).not.toContain("tcs_fixture_key");
    await io.cleanup();

    io = await fakeIo(["latest"]);
    io.routes.push(() => json({ events: [], next_cursor: 1, has_more: false }));
    expect(await main(io)).toBe(0);
    expect(io.calls[0].headers.authorization).toBeUndefined();
  });
});

describe("tocsin watch", () => {
  it("polls every 5 minutes, prints only new events, sends the ETag", async () => {
    io = await fakeIo(["watch"]);
    io.maxPolls = 3;
    let poll = 0;
    io.routes.push((c) => {
      const q = c.url.searchParams;
      if (q.get("order") === "desc") return json({ events: [event(9)], next_cursor: 10, has_more: false });
      poll++;
      if (poll === 1) return json({ events: [event(1), event(2)], next_cursor: 12, has_more: false }, 200, { ETag: '"a"' });
      if (poll === 2) return new Response(null, { status: 304 });
      return json({ events: [event(3)], next_cursor: 13, has_more: false }, 200, { ETag: '"b"' });
    });
    expect(await main(io)).toBe(0);
    const lines = io.text().out.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.split(" ")[3])).toEqual([event(1).id, event(2).id, event(3).id]);
    const polls = io.calls.filter((c) => c.url.searchParams.get("order") !== "desc");
    expect(polls.map((c) => c.url.searchParams.get("since"))).toEqual(["10", "12", "12"]);
    expect(polls[0].url.searchParams.get("limit")).toBe("100");
    expect(polls[0].headers["if-none-match"]).toBeUndefined();
    expect(polls[1].headers["if-none-match"]).toBe('"a"');
    expect(polls[2].url.searchParams.get("since")).toBe("12");
    expect(io.sleeps.length).toBeGreaterThanOrEqual(2);
    expect(io.sleeps.every((ms) => ms === 300_000)).toBe(true);
  });

  it("drains has_more pages at once, starts from --since, survives errors, honours Retry-After", async () => {
    io = await fakeIo(["watch", "--since", "5", "--ecosystem", "npm"]);
    io.maxPolls = 4;
    const answers: (() => Response)[] = [
      () => json({ events: [event(1)], next_cursor: 6, has_more: true }),
      () => json({ events: [event(2)], next_cursor: 7, has_more: false }),
      () => {
        throw new Error("socket hang up");
      },
      () => json({ error: "slow down" }, 429, { "Retry-After": "60" }),
      () => json({ events: [], next_cursor: 7, has_more: false }),
    ];
    io.routes.push(() => answers.shift()!());
    expect(await main(io)).toBe(0);
    expect(io.text().out.split("\n").filter((l) => l !== "")).toHaveLength(2);
    expect(io.calls.map((c) => c.url.searchParams.get("since"))).toEqual(["5", "6", "7", "7", "7"]);
    expect(io.calls.every((c) => c.url.searchParams.get("ecosystem") === "npm")).toBe(true);
    expect(io.text().err).toContain("socket hang up");
    expect(io.sleeps).toEqual([300_000, 300_000, 60_000]);
  });
});
