import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as action from "../../action/check.mjs";
import * as cli from "../../packages/cli/src/check.js";
import * as shared from "../../packages/cli/src/lockfiles.js";

const ACTION_SRC = new URL("../../action/check.mjs", import.meta.url);

describe("lockfile discovery is one shared module", () => {
  it("the Action and the CLI use the same functions and the same list", () => {
    expect(action.findLockfiles).toBe(shared.findLockfiles);
    expect(action.isLockfileName).toBe(shared.isLockfileName);
    expect(cli.isLockfileName).toBe(shared.isLockfileName);
    expect(JSON.stringify(action.LOCKFILE_NAMES)).toBe(JSON.stringify(cli.LOCKFILE_NAMES_FOR_TEST));
    expect(action.LOCKFILE_NAMES.length).toBeGreaterThanOrEqual(9);
  });

  it("the Action source holds no lockfile list of its own", async () => {
    const src = await readFile(ACTION_SRC, "utf8");
    expect(src).toContain('from "../packages/cli/src/lockfiles.js"');
    for (const name of shared.LOCKFILE_NAMES) expect([name, src.includes(`"${name}"`)]).toEqual([name, false]);
  });

  it("finds the same files the CLI finds, sorted, top level only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tocsin-lockfiles-"));
    try {
      for (const n of ["yarn.lock", "Cargo.lock", "package.json", "requirements-dev.txt", "go.mod", "README.md"]) {
        await writeFile(join(dir, n), `${n}\n`);
      }
      const found = await action.findLockfiles(dir);
      expect(found).toEqual([
        { name: "Cargo.lock", text: "Cargo.lock\n" },
        { name: "requirements-dev.txt", text: "requirements-dev.txt\n" },
        { name: "yarn.lock", text: "yarn.lock\n" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
