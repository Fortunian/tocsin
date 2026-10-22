import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { LOCKFILE_NAMES_FOR_TEST, isLockfileName } from "../../packages/cli/src/check.js";
import { detectParser } from "../../src/check/parsers/index.js";
import { ALL_RUNTIMES_ABSENT, fakeIo, json, type FakeIo, type FetchCall } from "./helpers.tcs-13.js";

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

let io: FakeIo | undefined;
afterEach(async () => {
  await io?.cleanup();
  io = undefined;
});

async function setup(argv: string[], env: Record<string, string> = {}): Promise<FakeIo> {
  io = await fakeIo(["check", ...argv], env);
  for (const [k, v] of ALL_RUNTIMES_ABSENT) io.commands.set(k, v);
  return io;
}

const isMultipart = (c: FetchCall) => c.body instanceof FormData;

function answer(io: FakeIo, lock: unknown, runtimes: unknown) {
  io.routes.push((c) => {
    if (c.method !== "POST" || c.url.pathname !== "/v1/check") return undefined;
    return isMultipart(c) ? json(lock) : json(runtimes);
  });
}

describe("tocsin check", () => {
  it("--json affected exit 1", async () => {
    const io = await setup(["--json"]);
    await copyFile(FIXTURE, join(io.cwd, "package-lock.json"));
    io.commands.set("node --version", { code: 0, stdout: "v22.1.0\n", stderr: "" });
    answer(io, { checked: 2, affected: [AFFECTED], skipped: [], feed_cursor: 7 }, { checked: 1, affected: [], skipped: [], feed_cursor: 5 });
    expect(await main(io)).toBe(1);
    const doc = JSON.parse(io.text().out);
    expect(doc.affected).toHaveLength(1);
    expect(doc.affected[0].advisory_id).toBe(AFFECTED.advisory_id);
    expect(doc.checked).toBe(3);
    expect(doc.feed_cursor).toBe(5);
    expect(io.calls).toHaveLength(2);
    const multi = io.calls.find(isMultipart)!;
    expect(multi.url.href).toBe("https://tocsin.sh/v1/check");
    const form = multi.body as FormData;
    expect([...form.keys()]).toEqual(["package-lock.json"]);
    expect(await (form.get("package-lock.json") as Blob).text()).toBe(await import("node:fs/promises").then((f) => f.readFile(FIXTURE, "utf8")));
    const rt = io.calls.find((c) => !isMultipart(c))!;
    expect(rt.method).toBe("POST");
    expect(rt.url.pathname).toBe("/v1/check");
    expect(rt.headers["content-type"]).toBe("application/json");
    expect(rt.body).toBe('{"runtimes":{"node":"22.1.0"}}');
  });

  it("clean exit 0", async () => {
    const io = await setup([]);
    await copyFile(FIXTURE, join(io.cwd, "package-lock.json"));
    io.commands.set("node --version", { code: 0, stdout: "v22.1.0\n", stderr: "" });
    answer(io, { checked: 2, affected: [], skipped: [], feed_cursor: 7 }, { checked: 1, affected: [], skipped: [], feed_cursor: 5 });
    expect(await main(io)).toBe(0);
    expect(io.text().out).toContain("No known advisory affects the 3 checked dependencies");
  });

  it("skipped items are counted and never read as clean", async () => {
    const io = await setup([]);
    await copyFile(FIXTURE, join(io.cwd, "package-lock.json"));
    answer(io, { checked: 1, affected: [], skipped: [{ dependency: { name: "x" }, reason: "unsupported" }], feed_cursor: 7 }, null);
    expect(await main(io)).toBe(0);
    expect(io.text().out).toContain("1 skipped");
  });

  it("nothing to check exit 2, 0 fetch calls", async () => {
    const io = await setup([]);
    expect(await main(io)).toBe(2);
    expect(io.text().err).toContain("no lockfile");
    expect(io.calls).toHaveLength(0);
  });

  it("table output lists the affected row and summary", async () => {
    const io = await setup([]);
    await copyFile(FIXTURE, join(io.cwd, "package-lock.json"));
    io.commands.set("node --version", { code: 0, stdout: "v22.1.0\n", stderr: "" });
    answer(io, { checked: 2, affected: [AFFECTED], skipped: [], feed_cursor: 7 }, { checked: 1, affected: [], skipped: [], feed_cursor: 5 });
    expect(await main(io)).toBe(1);
    const out = io.text().out;
    expect(out).toMatch(/^SEVERITY\s+PACKAGE@VERSION\s+ADVISORY\s+FIXED IN\s+ACTION/);
    expect(out).toContain("lodash@4.17.20");
    expect(out).toContain(AFFECTED.advisory_id);
    expect(out).toContain("4.17.21");
    expect(out).toContain("1 of 3 dependencies affected");
  });

  it("affected rows from both calls are re-sorted by severity, exploited, id", async () => {
    const io = await setup(["--json"]);
    await copyFile(FIXTURE, join(io.cwd, "package-lock.json"));
    io.commands.set("node --version", { code: 0, stdout: "v22.1.0\n", stderr: "" });
    const item = (id: string, label: string, exploited = false) => ({ ...AFFECTED, advisory_id: id, severity: { score: null, label }, exploited });
    answer(
      io,
      { checked: 2, affected: [item("b", "high"), item("c", "low")], skipped: [], feed_cursor: 7 },
      { checked: 1, affected: [item("a", "critical"), item("d", "high", true)], skipped: [], feed_cursor: 9 },
    );
    expect(await main(io)).toBe(1);
    expect(JSON.parse(io.text().out).affected.map((a: { advisory_id: string }) => a.advisory_id)).toEqual(["a", "d", "b", "c"]);
  });

  it("runtime versions parsed from 6 outputs", async () => {
    const io = await setup(["--json"]);
    io.commands.set("node --version", { code: 0, stdout: "v22.1.0\n", stderr: "" });
    io.commands.set("php --version", { code: 0, stdout: "PHP 8.3.1 (cli) (built: Dec 20 2023)\nCopyright (c) The PHP Group\n", stderr: "" });
    io.commands.set("python --version", "ENOENT");
    io.commands.set("python3 --version", { code: 0, stdout: "Python 3.12.1\n", stderr: "" });
    io.commands.set("go version", { code: 0, stdout: "go version go1.22.3 linux/amd64\n", stderr: "" });
    io.commands.set("bun --version", { code: 0, stdout: "1.1.38\n", stderr: "" });
    io.commands.set("deno --version", { code: 0, stdout: "deno 2.0.0 (stable, release, x86_64-unknown-linux-gnu)\nv8 12.9.202.13-rusty\ntypescript 5.6.2\n", stderr: "" });
    answer(io, null, { checked: 6, affected: [], skipped: [], feed_cursor: 5 });
    expect(await main(io)).toBe(0);
    expect(io.calls).toHaveLength(1);
    expect(JSON.parse(io.calls[0].body as string).runtimes).toEqual({
      node: "22.1.0",
      php: "8.3.1",
      python: "3.12.1",
      go: "1.22.3",
      bun: "1.1.38",
      deno: "2.0.0",
    });
  });

  it("a runtime that exits non-zero or prints no version is absent", async () => {
    const io = await setup(["--json"]);
    io.commands.set("node --version", { code: 1, stdout: "v22.1.0\n", stderr: "" });
    io.commands.set("php --version", { code: 0, stdout: "no version here\n", stderr: "" });
    io.commands.set("python --version", { code: 0, stdout: "", stderr: "Python 2.7.18\n" });
    answer(io, null, { checked: 1, affected: [], skipped: [], feed_cursor: 5 });
    expect(await main(io)).toBe(0);
    expect(JSON.parse(io.calls[0].body as string).runtimes).toEqual({ python: "2.7.18" });
    expect(io.execCalls).not.toContain("python3 --version");
  });

  it("500 and network error exit 3", async () => {
    const io = await setup([]);
    await copyFile(FIXTURE, join(io.cwd, "package-lock.json"));
    io.routes.push(() => json({ error: "boom" }, 500));
    expect(await main(io)).toBe(3);
    expect(io.text().err).toContain("check failed: 500 boom");

    io.routes.length = 0;
    io.stderr.length = 0;
    io.routes.push(() => {
      throw new Error("getaddrinfo ENOTFOUND tocsin.sh");
    });
    expect(await main(io)).toBe(3);
    expect(io.text().err).toContain("check failed: 0 getaddrinfo ENOTFOUND");

    io.routes.length = 0;
    io.routes.push(() => json({ checked: 1 }));
    expect(await main(io)).toBe(3);
    expect(io.text().out).toBe("");
  });

  it("lockfile matcher", async () => {
    const io = await setup([]);
    for (const name of ["package.json", "requirements.in", "yarn.lock.bak", "Cargo.lock", "requirements-dev.txt"]) {
      await writeFile(join(io.cwd, name), "x\n");
    }
    answer(io, { checked: 0, affected: [], skipped: [], feed_cursor: 1 }, null);
    expect(await main(io)).toBe(0);
    expect(io.calls).toHaveLength(1);
    expect([...(io.calls[0].body as FormData).keys()].sort()).toEqual(["Cargo.lock", "requirements-dev.txt"]);
  });

  it("the CLI matcher agrees with the API's detectParser", () => {
    const names = [
      ...LOCKFILE_NAMES_FOR_TEST,
      "Cargo.lock",
      "Gemfile.lock",
      "requirements-dev.txt",
      "requirements_test.txt",
      "requirements.prod.txt",
      "package.json",
      "requirements.in",
      "yarn.lock.bak",
      "go.mod",
      "requirements.txt.orig",
    ];
    expect(names.length).toBeGreaterThanOrEqual(12);
    for (const n of names) expect([n, isLockfileName(n)]).toEqual([n, detectParser(n) !== null]);
  });

  it("base url", async () => {
    const io = await setup(["--json"]);
    io.commands.set("node --version", { code: 0, stdout: "v22.1.0\n", stderr: "" });
    answer(io, null, { checked: 1, affected: [], skipped: [], feed_cursor: 5 });
    expect(await main(io)).toBe(0);
    expect(io.calls[0].url.href).toBe("https://tocsin.sh/v1/check");

    io.env.TOCSIN_BASE_URL = "https://x.test/";
    io.calls.length = 0;
    expect(await main(io)).toBe(0);
    expect(io.calls[0].url.href).toBe("https://x.test/v1/check");
  });
});
