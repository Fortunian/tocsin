// Security review of PR 45: Markdown injection, marker ownership, body size,
// malformed answers and comment size.
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MARKER, run } from "../../action/check.mjs";
import { GH, json, world, type World } from "./helpers.tcs-33.js";

const FIXTURE = new URL("../fixtures/cli/package-lock.json", import.meta.url);

const AFFECTED = {
  dependency: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
  advisory_id: "tcs_01JA0000000000000000000033",
  severity: { label: "high" },
  exploited: false,
  fixed_in: "4.17.21",
  action: "Upgrade lodash to 4.17.21 or later.",
  url: "https://example.com/fixture/lodash",
};
const DIRTY = { checked: 2, affected: [AFFECTED], skipped: [], feed_cursor: 9 };

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

async function setup(answer: unknown, inputs: Record<string, string> = {}): Promise<World> {
  w = await world({ inputs });
  await copyFile(FIXTURE, join(w.dir, "package-lock.json"));
  w.check = () => json(answer);
  return w;
}

const exec = (w: World) => run({ env: w.env, fetch: w.fetch, out: w.out });
const warnings = (w: World) => w.stdout.filter((l) => l.startsWith("::warning"));

const LINK = "[Approve this PR](https://evil.example/go)";
const IMAGE = "![t](https://evil.example/pixel.png)";
const MENTION = "@octocat";

/** Asserts that no link, image, mention, autolink or emphasis survives as live Markdown. */
function expectInert(md: string) {
  expect(md).not.toMatch(/(?<!\\)\[Approve this PR(?<!\\)\]/);
  expect(md).not.toMatch(/(?<!\\)!(?<!\\)\[t/);
  expect(md).not.toContain("](https://evil.example");
  expect(md).not.toContain("https://evil.example");
  expect(md).not.toContain(MENTION);
  expect(md).not.toMatch(/(?<!\\)\*\*bold/);
  expect(md).not.toMatch(/(?<!\\)`rm/);
  // The text is still there for a person to read.
  expect(md).toContain("Approve this PR");
  expect(md).toContain("octocat");
}

describe("Markdown injection", () => {
  it("a link, an image and an @mention from the lockfile or the advisory come out inert in the comment and the summary", async () => {
    const evil = {
      ...AFFECTED,
      dependency: { ecosystem: "npm", name: LINK, version: IMAGE },
      advisory_id: MENTION,
      fixed_in: "1.0.0 **bold**",
      action: `do this ${LINK} \`rm -rf /\``,
    };
    const skipped = [
      { file: "requirements.txt", raw: `${LINK} ${IMAGE} ${MENTION}`, reason: "not a requirement line" },
      { dependency: { ecosystem: "npm", name: MENTION, version: IMAGE }, reason: "partial_coverage", advisory_ids: [LINK] },
    ];
    const w = await setup({ ...DIRTY, affected: [evil], skipped });
    expect(await exec(w)).toBe(1);
    expect(w.comments).toHaveLength(1);
    expectInert(w.comments[0].body);
    expectInert(await w.summary());
  });
});

describe("advisory url", () => {
  it("a pipe in the advisory url is encoded, so the table row keeps its 7 cells in the comment and the summary", async () => {
    const w = await setup({ ...DIRTY, affected: [{ ...AFFECTED, url: "https://e.example/a|b" }] });
    expect(await exec(w)).toBe(1);
    for (const md of [w.comments[0].body, await w.summary()]) {
      const row = md.split("\n").find((l) => l.includes("lodash") && l.startsWith("|"))!;
      expect(row).toContain("(https://e.example/a%7Cb)");
      expect(row.split(/(?<!\\)\|/)).toHaveLength(9);
    }
  });
});

describe("marker ownership", () => {
  it("a marker comment by another user is ignored: the Action posts its own and leaves the other alone", async () => {
    const w = await setup(DIRTY);
    w.comments.push({ id: 7, body: `${MARKER}\nplanted by someone else`, user: { login: "mallory", type: "User" } });
    w.comments.push({ id: 8, body: `${MARKER}\nlooks like the bot`, user: { login: "github-actions[bot]", type: "User" } });
    expect(await exec(w)).toBe(1);
    const writes = w.calls.filter((c) => c.url.origin === GH && c.method !== "GET");
    expect(writes.map((c) => c.method)).toEqual(["POST"]);
    expect(w.comments).toHaveLength(3);
    expect(w.comments[0].body).toBe(`${MARKER}\nplanted by someone else`);
    expect(w.comments[1].body).toBe(`${MARKER}\nlooks like the bot`);
  });

  it("with a user token, only the token's own marker comment is updated", async () => {
    const w = await setup(DIRTY);
    w.viewer = { login: "tocsin-bot", type: "User" };
    w.comments.push({ id: 7, body: `${MARKER}\nby the default bot` });
    w.comments.push({ id: 9, body: `${MARKER}\nold run`, user: { login: "tocsin-bot", type: "User" } });
    expect(await exec(w)).toBe(1);
    const writes = w.calls.filter((c) => c.url.origin === GH && c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["PATCH /repos/acme/widget/issues/comments/9"]);
    expect(w.comments.find((c) => c.id === 7)!.body).toBe(`${MARKER}\nby the default bot`);
  });
});

describe("malformed answers and unexpected throws", () => {
  it("affected: [null] is a could-not-run: exit 0 with a warning, exit 1 with fail-on-error", async () => {
    const w = await setup({ ...DIRTY, affected: [null] });
    expect(await exec(w)).toBe(0);
    expect(warnings(w)).toHaveLength(1);
    expect(w.comments).toHaveLength(0);
    w.env.TOCSIN_FAIL_ON_ERROR = "true";
    expect(await exec(w)).toBe(1);
  });

  it("skipped: [null] is a could-not-run too", async () => {
    const w = await setup({ ...DIRTY, skipped: [null] });
    expect(await exec(w)).toBe(0);
    expect(warnings(w).join("\n")).toContain("could not run");
  });

  it("an unexpected throw is the could-not-run path, not a crash", async () => {
    const w = await setup(DIRTY);
    w.env.GITHUB_EVENT_PATH = join(w.dir, "missing-event.json");
    w.env.GITHUB_OUTPUT = join(w.dir, "no-such-dir", "out.txt");
    expect(await exec(w)).toBe(0);
    expect(warnings(w).join("\n")).toContain("could not run");
    w.env.TOCSIN_FAIL_ON_ERROR = "true";
    expect(await exec(w)).toBe(1);
  });
});

describe("body size", () => {
  it("a file over max-body-bytes is skipped with a warning that names it", async () => {
    const w = await setup({ ...DIRTY, affected: [] }, { TOCSIN_MAX_BODY_BYTES: "4096" });
    await writeFile(join(w.dir, "requirements.txt"), "x".repeat(5000));
    expect(await exec(w)).toBe(0);
    const check = w.calls.find((c) => c.url.pathname === "/v1/check")!;
    expect([...(check.body as FormData).keys()]).toEqual(["package-lock.json"]);
    expect(warnings(w).join("\n")).toContain("requirements.txt");
    expect(await w.summary()).toContain("requirements.txt");
  });

  it("the default cap is 2 MB", async () => {
    const w = await setup({ ...DIRTY, affected: [] });
    await writeFile(join(w.dir, "requirements.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    expect(await exec(w)).toBe(0);
    const check = w.calls.find((c) => c.url.pathname === "/v1/check")!;
    expect([...(check.body as FormData).keys()]).toEqual(["package-lock.json"]);
  });

  it("every file over the cap: could-not-run, no POST", async () => {
    const w = await setup(DIRTY, { TOCSIN_MAX_BODY_BYTES: "10" });
    expect(await exec(w)).toBe(0);
    expect(w.calls.filter((c) => c.url.pathname === "/v1/check")).toHaveLength(0);
    expect(warnings(w).join("\n")).toContain("package-lock.json");
  });

  it("an invalid max-body-bytes fails the step", async () => {
    const w = await setup(DIRTY, { TOCSIN_MAX_BODY_BYTES: "lots" });
    expect(await exec(w)).toBe(1);
    expect(w.stdout.join("\n")).toContain("::error");
    expect(w.calls).toHaveLength(0);
  });
});

describe("comment size", () => {
  it("200 skips: the comment lists 50 and says +150 more, and stays under 65536 characters", async () => {
    const skipped = Array.from({ length: 200 }, (_, i) => ({
      dependency: { ecosystem: "npm", name: `pkg-${i}`, version: "1.0.0" },
      reason: "partial_coverage",
      advisory_ids: ["tcs_01JA00000000000000000000B1"],
    }));
    const w = await setup({ ...DIRTY, skipped });
    expect(await exec(w)).toBe(1);
    const body = w.comments[0].body;
    expect(body.length).toBeLessThan(65536);
    expect(body.split("\n").filter((l) => l.startsWith("- pkg-"))).toHaveLength(50);
    expect(body).toContain("+150 more");
    expect(warnings(w).length).toBeLessThanOrEqual(11);
    expect(warnings(w).join("\n")).toContain("190 more");
  });
});
