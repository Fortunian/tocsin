import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findLockfiles, isLockfileName, LOCKFILE_NAMES } from "../../packages/cli/src/lockfiles.js";
import { detectParser, SUPPORTED_FILENAMES } from "../../src/check/parsers";

// TCS-38: npx tocsin check and the GitHub Action find and send the five new lockfile names.

describe("lockfile discovery for the TCS-38 names", () => {
  it("LOCKFILE_NAMES has the five new names; matching is case-insensitive", () => {
    for (const n of ["pom.xml", "gradle.lockfile", "packages.lock.json", "mix.lock", "pubspec.lock"]) expect(LOCKFILE_NAMES).toContain(n);
    expect(isLockfileName("POM.XML")).toBe(true);
    expect(isLockfileName("Packages.Lock.Json")).toBe(true);
    expect(isLockfileName("pubspec.yaml")).toBe(false);
  });

  it("is the same list the check endpoint parses", () => {
    for (const n of LOCKFILE_NAMES) expect(detectParser(n), n).not.toBeNull();
    for (const n of SUPPORTED_FILENAMES.filter((x) => !x.includes("*"))) expect(LOCKFILE_NAMES, n).toContain(n);
  });

  it("findLockfiles finds the new files at the top level", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tocsin-lockfiles-38-"));
    try {
      for (const n of ["pom.xml", "mix.lock", "pubspec.lock", "pubspec.yaml", "build.gradle"]) await writeFile(join(dir, n), `${n}\n`);
      expect((await findLockfiles(dir)).map((f) => f.name)).toEqual(["mix.lock", "pom.xml", "pubspec.lock"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
