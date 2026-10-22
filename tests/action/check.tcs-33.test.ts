import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MARKER, run, upgradeCell, upgradeCommand } from "../../action/check.mjs";
import { API, GH, json, world, type World } from "./helpers.tcs-33.js";

const FIXTURE = new URL("../fixtures/cli/package-lock.json", import.meta.url);

const AFFECTED = {
  dependency: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
  advisory_id: "tcs_01JA0000000000000000000033",
  cve_ids: ["CVE-2021-23337"],
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

async function setup(answer: unknown, opts: Parameters<typeof world>[0] = {}, status = 200): Promise<World> {
  w = await world(opts);
  await copyFile(FIXTURE, join(w.dir, "package-lock.json"));
  w.check = () => json(answer, status);
  return w;
}

const exec = (w: World) => run({ env: w.env, fetch: w.fetch, out: w.out });
const ghCalls = (w: World) => w.calls.filter((c) => c.url.origin === GH);
const warnings = (w: World) => w.stdout.filter((l) => l.startsWith("::warning"));

describe("tocsin GitHub Action", () => {
  it("one affected dependency: exit 1, a summary row, a PR comment with the upgrade command", async () => {
    const w = await setup(DIRTY);
    expect(await exec(w)).toBe(1);

    const check = w.calls.find((c) => c.url.origin === API)!;
    expect(check.url.href).toBe(`${API}/v1/check`);
    expect([...(check.body as FormData).keys()]).toEqual(["package-lock.json"]);

    const summary = await w.summary();
    expect(summary).toContain("| high | lodash | 4.17.20 | 4.17.21 |");
    expect(summary).toContain("[tcs_01JA0000000000000000000033](https://example.com/fixture/lodash)");
    expect(summary).toContain("`npm i lodash@4.17.21`");
    expect(await w.outputs()).toContain("affected=1");

    expect(w.comments).toHaveLength(1);
    const body = w.comments[0].body;
    expect(body).toContain(MARKER);
    expect(body).toContain("`npm i lodash@4.17.21`");
    expect(body).toContain("Upgrade lodash to 4.17.21 or later.");
    expect(body).toContain("4.17.21");
    expect(body).toContain("https://example.com/fixture/lodash");
    const post = ghCalls(w).find((c) => c.method === "POST")!;
    expect(post.headers.authorization).toBe("Bearer ghs_fake");
  });

  it("a clean lockfile: exit 0 and no comment", async () => {
    const w = await setup(CLEAN);
    expect(await exec(w)).toBe(0);
    expect(w.comments).toHaveLength(0);
    expect(ghCalls(w).filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(await w.summary()).toContain("No known advisory affects the 2 checked dependencies");
    expect(await w.outputs()).toContain("affected=0");
  });

  it("an API 500: exit 0 with a warning, exit 1 with fail-on-error", async () => {
    const w = await setup({ error: "boom" }, {}, 500);
    expect(await exec(w)).toBe(0);
    expect(warnings(w).join("\n")).toContain("500 boom");
    expect(w.comments).toHaveLength(0);

    w.env.TOCSIN_FAIL_ON_ERROR = "true";
    w.stdout.length = 0;
    expect(await exec(w)).toBe(1);
    expect(w.stdout.join("\n")).toContain("500 boom");
  });

  it("a network error is a could-not-run, never clean", async () => {
    const w = await setup(CLEAN);
    w.check = () => {
      throw new Error("getaddrinfo ENOTFOUND tocsin.sh");
    };
    expect(await exec(w)).toBe(0);
    expect(warnings(w).join("\n")).toContain("ENOTFOUND");
    expect(await w.summary()).not.toContain("No known advisory");
  });

  it("a malformed answer is a could-not-run, never clean", async () => {
    const w = await setup({ checked: 1 });
    expect(await exec(w)).toBe(0);
    expect(warnings(w)).toHaveLength(1);
    expect(await w.summary()).not.toContain("No known advisory");
  });

  it("a second run on the same PR updates the marker comment instead of adding one", async () => {
    const w = await setup(DIRTY);
    w.comments.push({ id: 7, body: "an unrelated review comment" });
    expect(await exec(w)).toBe(1);
    expect(w.comments).toHaveLength(2);
    const first = w.comments.find((c) => c.body.includes(MARKER))!;

    w.calls.length = 0;
    w.check = () => json({ ...DIRTY, affected: [{ ...AFFECTED, fixed_in: "4.17.22" }] });
    expect(await exec(w)).toBe(1);
    expect(w.comments).toHaveLength(2);
    expect(ghCalls(w).filter((c) => c.method === "POST")).toHaveLength(0);
    const patch = ghCalls(w).find((c) => c.method === "PATCH")!;
    expect(patch.url.pathname).toBe(`/repos/acme/widget/issues/comments/${first.id}`);
    expect(first.body).toContain("`npm i lodash@4.17.22`");
    expect(w.comments.find((c) => c.id === 7)!.body).toBe("an unrelated review comment");
  });

  it("a clean run after an affected one updates the marker comment to clean", async () => {
    const w = await setup(DIRTY);
    expect(await exec(w)).toBe(1);
    w.check = () => json(CLEAN);
    expect(await exec(w)).toBe(0);
    expect(w.comments).toHaveLength(1);
    expect(w.comments[0].body).toContain(MARKER);
    expect(w.comments[0].body).not.toContain("npm i lodash");
  });

  it("comment: false and a push event post no comment", async () => {
    const off = await setup(DIRTY, { inputs: { TOCSIN_COMMENT: "false" } });
    expect(await exec(off)).toBe(1);
    expect(ghCalls(off)).toHaveLength(0);
    await off.cleanup();

    const push = await setup(DIRTY, { event: "push" });
    expect(await exec(push)).toBe(1);
    expect(ghCalls(push)).toHaveLength(0);
  });

  it("a comment that cannot be posted is a warning, not a change of outcome", async () => {
    const w = await setup(DIRTY);
    const base = w.fetch;
    w.fetch = async (url, init) => {
      if (new URL(url).origin === GH) return json({ message: "Resource not accessible by integration" }, 403);
      return base(url, init);
    };
    expect(await exec(w)).toBe(1);
    expect(warnings(w).join("\n")).toContain("403");
  });

  it("min-severity filters lower severities; unknown severity always counts", async () => {
    const low = { ...AFFECTED, advisory_id: "tcs_01JA00000000000000000000A1", severity: { label: "low" } };
    const unknown = { ...AFFECTED, advisory_id: "tcs_01JA00000000000000000000A2", severity: { label: "unknown" } };
    const w = await setup({ ...CLEAN, affected: [low] }, { inputs: { TOCSIN_MIN_SEVERITY: "high" } });
    expect(await exec(w)).toBe(0);
    expect(w.comments).toHaveLength(0);

    w.check = () => json({ ...CLEAN, affected: [low, unknown] });
    expect(await exec(w)).toBe(1);
    expect(await w.summary()).toContain("tcs_01JA00000000000000000000A2");
  });

  it("fail-on: exploited fails only on an exploited advisory; never always passes", async () => {
    const w = await setup(DIRTY, { inputs: { TOCSIN_FAIL_ON: "exploited" } });
    expect(await exec(w)).toBe(0);
    expect(w.comments).toHaveLength(1);
    w.check = () => json({ ...DIRTY, affected: [{ ...AFFECTED, exploited: true }] });
    expect(await exec(w)).toBe(1);
    w.env.TOCSIN_FAIL_ON = "never";
    expect(await exec(w)).toBe(0);
  });

  it("an invalid input fails the step with an error annotation", async () => {
    const w = await setup(DIRTY, { inputs: { TOCSIN_MIN_SEVERITY: "severe" } });
    expect(await exec(w)).toBe(1);
    expect(w.stdout.join("\n")).toContain("::error");
    expect(w.calls).toHaveLength(0);
    w.env.TOCSIN_MIN_SEVERITY = "low";
    w.env.TOCSIN_FAIL_ON = "sometimes";
    expect(await exec(w)).toBe(1);
    expect(w.calls).toHaveLength(0);
  });

  it("partial_coverage and other skips are warnings, never clean", async () => {
    const skipped = [
      { dependency: { ecosystem: "npm", name: "minimist", version: "1.2.5" }, reason: "partial_coverage", advisory_ids: ["tcs_01JA00000000000000000000B1"] },
    ];
    const w = await setup({ ...CLEAN, skipped });
    expect(await exec(w)).toBe(0);
    expect(warnings(w).join("\n")).toContain("minimist@1.2.5");
    expect(warnings(w).join("\n")).toContain("partial_coverage");
    const summary = await w.summary();
    expect(summary).toContain("1 skipped");
    expect(summary).not.toMatch(/^No known advisory affects the 2 checked dependencies\.$/m);
  });

  it("no lockfile: a warning and exit 0; exit 1 with fail-on-error", async () => {
    w = await world();
    expect(await exec(w)).toBe(0);
    expect(warnings(w).join("\n")).toContain("no lockfile");
    expect(w.calls).toHaveLength(0);
    w.env.TOCSIN_FAIL_ON_ERROR = "true";
    expect(await exec(w)).toBe(1);
  });

  it("working-directory picks the directory to scan", async () => {
    w = await world({ inputs: { TOCSIN_WORKING_DIRECTORY: "app" } });
    await import("node:fs/promises").then((fs) => fs.mkdir(join(w!.dir, "app")));
    await writeFile(join(w.dir, "app", "requirements.txt"), "django==3.2.0\n");
    w.check = () => json(CLEAN);
    expect(await exec(w)).toBe(0);
    expect([...(w.calls[0].body as FormData).keys()]).toEqual(["requirements.txt"]);
  });

  it("sends the API key when set, and the user agent", async () => {
    const w = await setup(CLEAN, { inputs: { TOCSIN_API_KEY: "tk_fake" } });
    await exec(w);
    const check = w.calls.find((c) => c.url.origin === API)!;
    expect(check.headers.authorization).toBe("Bearer tk_fake");
    expect(check.headers["user-agent"]).toMatch(/^tocsin-action\//);
  });

  it("an advisory action with markdown or newlines cannot break the table", async () => {
    const w = await setup({ ...DIRTY, affected: [{ ...AFFECTED, action: "a | b\nc <script>" }] });
    expect(await exec(w)).toBe(1);
    const row = (await w.summary()).split("\n").find((l) => l.includes("lodash"))!;
    expect(row).toContain("a \\| b c &lt;script&gt;");
  });
});

describe("upgradeCommand", () => {
  it.each([
    ["npm", "lodash", "4.17.21", "npm i lodash@4.17.21"],
    ["PyPI", "django", "3.2.25", "pip install django==3.2.25"],
    ["Go", "golang.org/x/net", "0.23.0", "go get golang.org/x/net@v0.23.0"],
    ["Go", "golang.org/x/net", "v0.23.0", "go get golang.org/x/net@v0.23.0"],
    ["Packagist", "guzzlehttp/guzzle", "7.4.5", "composer require guzzlehttp/guzzle:7.4.5"],
    ["crates.io", "tokio", "1.18.5", "cargo update -p tokio --precise 1.18.5"],
    ["RubyGems", "rails", "7.0.8", "bundle update rails"],
  ])("%s %s %s", (eco, name, fixed, cmd) => {
    expect(upgradeCommand(eco, name, fixed)).toBe(cmd);
  });

  it.each([["stdlib"], ["toolchain"], ["cmd/go"]])("Go %s: no go get command, only Upgrade Go to <version>", (name) => {
    expect(upgradeCommand("Go", name, "1.21.12")).toBeNull();
    expect(upgradeCell("Go", name, "1.21.12")).toBe("Upgrade Go to 1.21.12");
    expect(upgradeCell("Go", name, "v1.21.12")).toBe("Upgrade Go to 1.21.12");
  });

  it("a Go stdlib row in the summary says Upgrade Go, never go get", async () => {
    const stdlib = { ...AFFECTED, dependency: { ecosystem: "Go", name: "stdlib", version: "1.21.0" }, fixed_in: "1.21.12" };
    const w = await setup({ ...DIRTY, affected: [stdlib] });
    expect(await exec(w)).toBe(1);
    const summary = await w.summary();
    expect(summary).toContain("| Upgrade Go to 1.21.12 |");
    expect(summary).not.toContain("go get");
  });

  it("no fixed version or an unknown ecosystem: no command", () => {
    expect(upgradeCommand("npm", "lodash", null)).toBeNull();
    expect(upgradeCommand("node", "node", "24.1.0")).toBeNull();
  });
});
