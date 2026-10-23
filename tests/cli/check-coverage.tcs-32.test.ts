import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { ALL_RUNTIMES_ABSENT, fakeIo, json, type FakeIo, type FetchCall } from "./helpers.tcs-13.js";

// `tocsin check` and the server's coverage field (TCS-32): a Coverage line,
// exit 3 when a checked ecosystem is partial and nothing is affected.
const FIXTURE = new URL("../fixtures/cli/package-lock.json", import.meta.url);

const AFFECTED = {
  dependency: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
  advisory_id: "tcs_01JA0000000000000000000001",
  cve_ids: ["CVE-2021-23337"],
  severity: { score: 7.2, label: "high" },
  exploited: false,
  fixed_in: "4.17.21",
  action: "Upgrade lodash to 4.17.21 or later.",
  url: "https://example.com/fixture/lodash",
};
const NPM_DONE = { ecosystem: "npm", since: "2016-01-05T00:00:00Z", complete: true };
const NODE_PARTIAL = { ecosystem: "node", since: null, complete: false };
const PARTIAL_SKIP = { dependency: { ecosystem: "node", name: "node", version: "22.1.0" }, reason: "partial_coverage", since: null };

let io: FakeIo | undefined;
afterEach(async () => {
  await io?.cleanup();
  io = undefined;
});

async function setup(argv: string[]): Promise<FakeIo> {
  io = await fakeIo(["check", ...argv]);
  for (const [k, v] of ALL_RUNTIMES_ABSENT) io.commands.set(k, v);
  await copyFile(FIXTURE, join(io.cwd, "package-lock.json"));
  io.commands.set("node --version", { code: 0, stdout: "v22.1.0\n", stderr: "" });
  return io;
}

const isMultipart = (c: FetchCall) => c.body instanceof FormData;
function answer(io: FakeIo, lock: unknown, runtimes: unknown) {
  io.routes.push((c) => (c.method === "POST" && c.url.pathname === "/v1/check" ? json(isMultipart(c) ? lock : runtimes) : undefined));
}

describe("tocsin check coverage", () => {
  it("a partial ecosystem and nothing affected: exit 3 and a Coverage line naming the partial ecosystem", async () => {
    const io = await setup([]);
    answer(io, { checked: 2, affected: [], skipped: [], feed_cursor: 7, coverage: [NPM_DONE] }, { checked: 1, affected: [], skipped: [PARTIAL_SKIP], feed_cursor: 7, coverage: [NODE_PARTIAL] });
    expect(await main(io)).toBe(3);
    const out = io.text().out;
    expect(out).toContain("Coverage: node partial (since unknown), npm since 2016-01-05");
    expect(out).not.toMatch(/^No known advisory affects/m);
  });

  it("affected plus partial: exit 1 (affected wins), and the Coverage line is printed", async () => {
    const io = await setup([]);
    answer(io, { checked: 2, affected: [AFFECTED], skipped: [], feed_cursor: 7, coverage: [NPM_DONE] }, { checked: 1, affected: [], skipped: [PARTIAL_SKIP], feed_cursor: 7, coverage: [NODE_PARTIAL] });
    expect(await main(io)).toBe(1);
    expect(io.text().out).toContain("Coverage: node partial (since unknown), npm since 2016-01-05");
  });

  it("all complete and clean: exit 0", async () => {
    const io = await setup([]);
    const nodeDone = { ecosystem: "node", since: "2018-03-01T00:00:00Z", complete: true };
    answer(io, { checked: 2, affected: [], skipped: [], feed_cursor: 7, coverage: [NPM_DONE] }, { checked: 1, affected: [], skipped: [], feed_cursor: 7, coverage: [nodeDone] });
    expect(await main(io)).toBe(0);
    expect(io.text().out).toContain("Coverage: node since 2018-03-01, npm since 2016-01-05");
  });

  it("an answer with no coverage field (an older server): exit codes as before, no Coverage line", async () => {
    const io = await setup([]);
    answer(io, { checked: 2, affected: [], skipped: [], feed_cursor: 7 }, { checked: 1, affected: [], skipped: [], feed_cursor: 7 });
    expect(await main(io)).toBe(0);
    expect(io.text().out).not.toContain("Coverage:");
  });

  it("merge: one ecosystem in two answers is partial if either part says partial; --json carries coverage", async () => {
    const io = await setup(["--json"]);
    answer(io, { checked: 2, affected: [], skipped: [], feed_cursor: 7, coverage: [{ ecosystem: "node", since: "2018-03-01T00:00:00Z", complete: true }] }, { checked: 1, affected: [], skipped: [], feed_cursor: 7, coverage: [NODE_PARTIAL] });
    expect(await main(io)).toBe(3);
    const doc = JSON.parse(io.text().out) as { coverage: unknown[] };
    expect(doc.coverage).toEqual([{ ecosystem: "node", since: "2018-03-01T00:00:00Z", complete: false }]);
  });
});
