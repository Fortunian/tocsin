/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import {
  detect,
  LockfileParseError,
  parseCargoLock,
  parseComposerLock,
  parseGemfileLock,
  parseGoSum,
  parsePackageLock,
  parsePnpmLock,
  parseRequirements,
  parseRuntimes,
  parseYarnLock,
  type Dependency,
  type ParseResult,
} from "../../src/check/parsers";
import cargoLock from "../fixtures/lockfiles/Cargo.lock?raw";
import composerLock from "../fixtures/lockfiles/composer.lock?raw";
import gemfileLock from "../fixtures/lockfiles/Gemfile.lock?raw";
import goSum from "../fixtures/lockfiles/go.sum?raw";
import packageLockV2 from "../fixtures/lockfiles/package-lock.v2.json?raw";
import packageLockV3 from "../fixtures/lockfiles/package-lock.v3.json?raw";
import pnpmLock from "../fixtures/lockfiles/pnpm-lock.yaml?raw";
import requirementsTxt from "../fixtures/lockfiles/requirements.txt?raw";
import yarnBerry from "../fixtures/lockfiles/yarn.berry.lock?raw";
import yarnV1 from "../fixtures/lockfiles/yarn.v1.lock?raw";

function has(r: ParseResult, d: Dependency): boolean {
  return r.dependencies.some(
    (x) => x.ecosystem === d.ecosystem && x.name === d.name && x.version === d.version,
  );
}

function detected(filename: string, text: string) {
  const d = detect(filename, text);
  if (!d) throw new Error(`detect(${filename}) returned null`);
  return d;
}

function allEcosystem(r: ParseResult, ecosystem: string): boolean {
  return r.dependencies.every((d) => d.ecosystem === ecosystem);
}

describe("fixtures load", () => {
  it("loads every recorded fixture as non-empty text", () => {
    for (const t of [
      cargoLock, composerLock, gemfileLock, goSum, packageLockV2, packageLockV3,
      pnpmLock, requirementsTxt, yarnBerry, yarnV1,
    ]) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(500);
    }
  });
});

describe("npm family", () => {
  it("package-lock v3 through detect()", () => {
    const d = detected("package-lock.json", packageLockV3);
    expect(d.parser).toBe("package-lock");
    expect(d.result.dependencies.length).toBe(251);
    expect(has(d.result, { ecosystem: "npm", name: "hono", version: "4.13.13" })).toBe(true);
    expect(has(d.result, { ecosystem: "npm", name: "@cloudflare/workers-types", version: "5.20261021.1" })).toBe(true);
    expect(allEcosystem(d.result, "npm")).toBe(true);
  });

  it("package-lock v2 through detect()", () => {
    const d = detected("sub/dir/package-lock.json", packageLockV2);
    expect(d.parser).toBe("package-lock");
    expect(d.result.dependencies.length).toBe(40);
    expect(has(d.result, { ecosystem: "npm", name: "hono", version: "4.13.13" })).toBe(true);
    expect(allEcosystem(d.result, "npm")).toBe(true);
  });

  it("pnpm-lock through detect()", () => {
    const d = detected("pnpm-lock.yaml", pnpmLock);
    expect(d.parser).toBe("pnpm-lock");
    expect(d.result.dependencies.length).toBe(40);
    expect(has(d.result, { ecosystem: "npm", name: "hono", version: "4.13.13" })).toBe(true);
    expect(has(d.result, { ecosystem: "npm", name: "@vitest/spy", version: "4.1.12" })).toBe(true);
    expect(allEcosystem(d.result, "npm")).toBe(true);
  });

  it("yarn v1 lockfile", () => {
    const r = parseYarnLock(yarnV1);
    expect(r.dependencies.length).toBe(40);
    expect(has(r, { ecosystem: "npm", name: "hono", version: "4.13.13" })).toBe(true);
    expect(has(r, { ecosystem: "npm", name: "@vitest/spy", version: "4.1.12" })).toBe(true);
    expect(detected("yarn.lock", yarnV1).result.dependencies.length).toBe(40);
  });

  it("yarn berry lockfile, workspace entry skipped, patch entry deduped", () => {
    const r = parseYarnLock(yarnBerry);
    expect(r.dependencies.length).toBe(39);
    expect(has(r, { ecosystem: "npm", name: "hono", version: "4.13.13" })).toBe(true);
    expect(has(r, { ecosystem: "npm", name: "fsevents", version: "2.3.3" })).toBe(true);
    expect(r.dependencies.some((d) => d.name === "tocsin")).toBe(false);
    expect(r.skipped.map((s) => s.raw)).toContain("tocsin@workspace:.");
    expect(detected("yarn.lock", yarnBerry).result.dependencies.length).toBe(39);
  });

  it("package-lock edge cases", () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "app", version: "1.0.0" },
        "node_modules/@scope/pkg": { version: "2.0.0" },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/a/node_modules/b": { version: "3.1.0" },
        "node_modules/b": { version: "3.1.0" },
        "node_modules/alias": { name: "real-name", version: "4.0.0" },
        "node_modules/local": { resolved: "packages/local", link: true },
        "packages/local": { name: "local", version: "0.0.1" },
      },
    });
    const r = parsePackageLock(text);
    expect(r.dependencies).toEqual([
      { ecosystem: "npm", name: "@scope/pkg", version: "2.0.0" },
      { ecosystem: "npm", name: "a", version: "1.0.0" },
      { ecosystem: "npm", name: "b", version: "3.1.0" },
      { ecosystem: "npm", name: "real-name", version: "4.0.0" },
    ]);
    expect(r.skipped.map((s) => [s.raw, s.reason])).toEqual([
      ["node_modules/local", "linked local package"],
      ["packages/local", "local workspace package"],
    ]);
    expect(() => parsePackageLock("{not json")).toThrow(LockfileParseError);
    expect(() => parsePackageLock(JSON.stringify({ lockfileVersion: 1, dependencies: {} }))).toThrow(
      LockfileParseError,
    );
  });

  it("pnpm edge cases: v5, v6, v9 keys, peer suffix, scoped", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "",
      "packages:",
      "",
      "  '@babel/core@7.24.0':",
      "    resolution: {integrity: sha512-x}",
      "",
      "  react-dom@18.2.0(react@18.2.0):",
      "    resolution: {integrity: sha512-y}",
      "",
      "  /lodash/4.17.21:",
      "    resolution: {integrity: sha512-z}",
      "",
      "  /left-pad@1.3.0:",
      "    dev: false",
      "",
      "snapshots:",
      "",
      "  should-not-count@9.9.9: {}",
      "",
    ].join("\n");
    expect(parsePnpmLock(text).dependencies).toEqual([
      { ecosystem: "npm", name: "@babel/core", version: "7.24.0" },
      { ecosystem: "npm", name: "react-dom", version: "18.2.0" },
      { ecosystem: "npm", name: "lodash", version: "4.17.21" },
      { ecosystem: "npm", name: "left-pad", version: "1.3.0" },
    ]);
  });

  it("yarn v1 multi-descriptor line yields one dependency", () => {
    const text = [
      "# yarn lockfile v1",
      "",
      "",
      '"@babel/core@^7.0.0", "@babel/core@^7.1.0":',
      '  version "7.24.0"',
      '  resolved "https://registry.yarnpkg.com/@babel/core/-/core-7.24.0.tgz"',
      "",
    ].join("\n");
    expect(parseYarnLock(text).dependencies).toEqual([
      { ecosystem: "npm", name: "@babel/core", version: "7.24.0" },
    ]);
  });
});

describe("requirements", () => {
  it("flask's pip-compile file through detect()", () => {
    const d = detected("requirements.txt", requirementsTxt);
    expect(d.parser).toBe("requirements");
    expect(d.result.dependencies.length).toBe(21);
    expect(has(d.result, { ecosystem: "PyPI", name: "flask", version: "2.3.2" })).toBe(true);
    expect(has(d.result, { ecosystem: "PyPI", name: "celery", version: "5.2.7" })).toBe(true);
    expect(d.result.skipped).toEqual([]);
  });

  it("requests>=2.0 lands in skipped[], not in the result", () => {
    const r = parseRequirements("requests>=2.0\nflask==3.0.0\n");
    expect(r.dependencies).toEqual([{ ecosystem: "PyPI", name: "flask", version: "3.0.0" }]);
    expect(r.dependencies.some((d) => d.name === "requests")).toBe(false);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ raw: "requests>=2.0", line: 1 });
  });

  it("normalizes names, reads extras and markers, skips wildcards and bare names", () => {
    const text = [
      "# comment",
      "-r base.txt",
      "--index-url https://example.invalid/simple",
      "Django==4.2.7",
      "zope.interface==6.0  # pinned",
      'requests[security]==2.31.0 ; python_version > "3.8"',
      "pkg==1.*",
      "bare-name",
      "two==1.0,<2",
      "urllib3==2.0.7 \\",
      "    --hash=sha256:fixture0000",
      "-e ./local",
      "",
    ].join("\n");
    const r = parseRequirements(text);
    expect(r.dependencies).toEqual([
      { ecosystem: "PyPI", name: "django", version: "4.2.7" },
      { ecosystem: "PyPI", name: "zope-interface", version: "6.0" },
      { ecosystem: "PyPI", name: "requests", version: "2.31.0" },
      { ecosystem: "PyPI", name: "urllib3", version: "2.0.7" },
    ]);
    expect(r.skipped.map((s) => [s.line, s.raw])).toEqual([
      [7, "pkg==1.*"],
      [8, "bare-name"],
      [9, "two==1.0,<2"],
      [12, "-e ./local"],
    ]);
  });

  it("empty file is a valid file with no pins", () => {
    expect(parseRequirements("")).toEqual({ dependencies: [], skipped: [] });
  });
});

describe("other ecosystems", () => {
  it("go.sum through detect(), /go.mod duplicates count once", () => {
    const d = detected("go.sum", goSum);
    expect(d.parser).toBe("go-sum");
    expect(d.result.dependencies.length).toBe(23);
    expect(allEcosystem(d.result, "Go")).toBe(true);
    const color = d.result.dependencies.filter((x) => x.name === "github.com/fatih/color");
    expect(color).toEqual([{ ecosystem: "Go", name: "github.com/fatih/color", version: "v1.18.0" }]);
    expect(d.result.dependencies.some((x) => x.version.endsWith("/go.mod"))).toBe(false);
  });

  it("go.sum keeps +incompatible and skips short lines", () => {
    const r = parseGoSum(
      "github.com/x/y v2.0.0+incompatible h1:fixture=\ngithub.com/x/y v2.0.0+incompatible/go.mod h1:fixture=\nbroken-line\n",
    );
    expect(r.dependencies).toEqual([{ ecosystem: "Go", name: "github.com/x/y", version: "v2.0.0+incompatible" }]);
    expect(r.skipped).toMatchObject([{ line: 3, raw: "broken-line" }]);
  });

  it("composer.lock through detect(), packages and packages-dev", () => {
    const d = detected("composer.lock", composerLock);
    expect(d.parser).toBe("composer-lock");
    expect(d.result.dependencies.length).toBe(24);
    expect(allEcosystem(d.result, "Packagist")).toBe(true);
    expect(has(d.result, { ecosystem: "Packagist", name: "guzzlehttp/guzzle", version: "6.3.0" })).toBe(true);
    expect(has(d.result, { ecosystem: "Packagist", name: "symfony/process", version: "dev-master" })).toBe(true);
    expect(() => parseComposerLock("{}")).toThrow(LockfileParseError);
    expect(() => parseComposerLock("")).toThrow(LockfileParseError);
  });

  it("Cargo.lock through detect(), non-registry package skipped", () => {
    const d = detected("Cargo.lock", cargoLock);
    expect(d.parser).toBe("cargo-lock");
    expect(d.result.dependencies.length).toBe(40);
    expect(allEcosystem(d.result, "crates.io")).toBe(true);
    expect(has(d.result, { ecosystem: "crates.io", name: "ahash", version: "0.8.12" })).toBe(true);
    expect(d.result.dependencies.some((x) => x.name === "pydantic-core")).toBe(false);
    expect(d.result.skipped.map((s) => s.raw)).toEqual(["pydantic-core 2.50.1"]);
  });

  it("Gemfile.lock through detect(), PATH spec skipped", () => {
    const d = detected("Gemfile.lock", gemfileLock);
    expect(d.parser).toBe("gemfile-lock");
    expect(d.result.dependencies.length).toBe(127);
    expect(allEcosystem(d.result, "RubyGems")).toBe(true);
    expect(has(d.result, { ecosystem: "RubyGems", name: "rails", version: "4.2.5" })).toBe(true);
    expect(has(d.result, { ecosystem: "RubyGems", name: "nokogiri", version: "1.6.7.1" })).toBe(true);
    expect(d.result.dependencies.some((x) => x.name === "decima-ruby")).toBe(false);
    expect(d.result.skipped.map((s) => s.raw)).toEqual(["decima-ruby (0.1.0)"]);
  });

  it("Gemfile.lock GIT section is skipped, platform suffix kept", () => {
    const text = [
      "GIT",
      "  remote: https://example.invalid/repo.git",
      "  revision: 0000000000000000000000000000000000000000",
      "  specs:",
      "    fromgit (1.0.0)",
      "",
      "GEM",
      "  remote: https://rubygems.org/",
      "  specs:",
      "    nokogiri (1.15.0-x86_64-linux)",
      "      racc (~> 1.4)",
      "    racc (1.7.1)",
      "",
      "PLATFORMS",
      "  x86_64-linux",
      "",
    ].join("\n");
    const r = parseGemfileLock(text);
    expect(r.dependencies).toEqual([
      { ecosystem: "RubyGems", name: "nokogiri", version: "1.15.0-x86_64-linux" },
      { ecosystem: "RubyGems", name: "racc", version: "1.7.1" },
    ]);
    expect(r.skipped).toMatchObject([{ line: 5, raw: "fromgit (1.0.0)" }]);
  });

  it("Cargo.lock package with git source is skipped", () => {
    const text = [
      "version = 3",
      "",
      "[[package]]",
      'name = "fromgit"',
      'version = "0.1.0"',
      'source = "git+https://example.invalid/repo#abc"',
      "",
      "[[package]]",
      'name = "serde"',
      'version = "1.0.200"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
    ].join("\n");
    const r = parseCargoLock(text);
    expect(r.dependencies).toEqual([{ ecosystem: "crates.io", name: "serde", version: "1.0.200" }]);
    expect(r.skipped.map((s) => s.raw)).toEqual(["fromgit 0.1.0"]);
  });
});

describe("runtimes", () => {
  it("returns runtime dependencies with ecosystem equal to name", () => {
    const r = parseRuntimes({ node: "22.11.0", php: "8.3.12" });
    expect(r.dependencies).toEqual([
      { ecosystem: "node", name: "node", version: "22.11.0" },
      { ecosystem: "php", name: "php", version: "8.3.12" },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it("covers all six runtimes", () => {
    const r = parseRuntimes({ node: "1", php: "2", python: "3", go: "4", deno: "5", bun: "6" });
    expect(r.dependencies.map((d) => [d.ecosystem, d.name])).toEqual([
      ["node", "node"], ["php", "php"], ["python", "python"], ["go", "go"], ["deno", "deno"], ["bun", "bun"],
    ]);
  });

  it("empty input, blank value, unknown key", () => {
    expect(parseRuntimes({})).toEqual({ dependencies: [], skipped: [] });
    const blank = parseRuntimes({ node: " " });
    expect(blank.dependencies).toEqual([]);
    expect(blank.skipped).toHaveLength(1);
    const unknown = parseRuntimes({ ruby: "3.3" });
    expect(unknown.dependencies).toEqual([]);
    expect(unknown.skipped).toHaveLength(1);
    expect(parseRuntimes({ node: undefined })).toEqual({ dependencies: [], skipped: [] });
  });
});

describe("detect", () => {
  it.each([
    ["package-lock.json", "package-lock"],
    ["sub/dir/package-lock.json", "package-lock"],
    ["npm-shrinkwrap.json", "package-lock"],
    ["pnpm-lock.yaml", "pnpm-lock"],
    ["yarn.lock", "yarn-lock"],
    ["requirements.txt", "requirements"],
    ["requirements-dev.txt", "requirements"],
    ["C:\\proj\\requirements.txt", "requirements"],
    ["go.sum", "go-sum"],
    ["composer.lock", "composer-lock"],
    ["Cargo.lock", "cargo-lock"],
    ["cargo.lock", "cargo-lock"],
    ["Gemfile.lock", "gemfile-lock"],
  ])("%s -> %s", (filename, parser) => {
    const text = parser === "package-lock" ? '{"packages":{}}' : parser === "composer-lock" ? '{"packages":[]}' : "";
    expect(detect(filename, text)?.parser).toBe(parser);
  });

  it.each(["package.json", "go.mod", "Gemfile", "requirements.in", "poetry.lock"])(
    "%s -> null",
    (filename) => {
      expect(detect(filename, "anything")).toBeNull();
    },
  );

  it("malformed JSON lockfile throws LockfileParseError", () => {
    expect(() => detect("package-lock.json", "{oops")).toThrow(LockfileParseError);
    expect(() => detect("composer.lock", "{oops")).toThrow(LockfileParseError);
  });
});

describe("branch coverage", () => {
  it("pnpm v5 scoped and peer-suffixed keys, non-registry key skipped", () => {
    const text = [
      "lockfileVersion: 5.4",
      "",
      "packages:",
      "",
      "  /@babel/core/7.24.0:",
      "    dev: false",
      "",
      "  /react-dom/18.2.0_react@18.2.0:",
      "    dev: false",
      "",
      "  string_decoder@1.3.0:",
      "    dev: false",
      "",
      "  local-pkg@file:../local-pkg:",
      "    dev: false",
      "",
    ].join("\n");
    const r = parsePnpmLock(text);
    expect(r.dependencies).toEqual([
      { ecosystem: "npm", name: "@babel/core", version: "7.24.0" },
      { ecosystem: "npm", name: "react-dom", version: "18.2.0" },
      { ecosystem: "npm", name: "string_decoder", version: "1.3.0" },
    ]);
    expect(r.skipped).toMatchObject([{ raw: "local-pkg@file:../local-pkg", reason: "not from a registry" }]);
  });

  it("yarn berry link: and file: descriptors are skipped", () => {
    const text = [
      "__metadata:",
      "  version: 8",
      "",
      '"a@link:../a":',
      "  version: 0.0.0-use.local",
      "",
      '"b@file:../b.tgz::locator=x%40workspace%3A.":',
      "  version: 1.0.0",
      "",
      '"c@npm:^1.0.0":',
      "  version: 1.2.0",
      "",
    ].join("\n");
    const r = parseYarnLock(text);
    expect(r.dependencies).toEqual([{ ecosystem: "npm", name: "c", version: "1.2.0" }]);
    expect(r.skipped.map((s) => s.raw)).toEqual(["a@link:../a", "b@file:../b.tgz::locator=x%40workspace%3A."]);
  });

  it("package-lock entry without a version is skipped", () => {
    const r = parsePackageLock(JSON.stringify({ packages: { "node_modules/x": {} } }));
    expect(r.dependencies).toEqual([]);
    expect(r.skipped).toMatchObject([{ raw: "node_modules/x", reason: "no version" }]);
  });

  it("composer entry without a version is skipped, packages-dev alone is valid", () => {
    const r = parseComposerLock(JSON.stringify({ "packages-dev": [{ name: "a/b" }, { name: "c/d", version: "1.0.0" }] }));
    expect(r.dependencies).toEqual([{ ecosystem: "Packagist", name: "c/d", version: "1.0.0" }]);
    expect(r.skipped).toHaveLength(1);
    expect(() => parseComposerLock(JSON.stringify({ packages: {} }))).toThrow(LockfileParseError);
  });

  it("Cargo sparse registry source is a dependency, block without version is skipped", () => {
    const text = [
      "[[package]]",
      'name = "serde"',
      'version = "1.0.200"',
      'source = "sparse+https://index.crates.io/"',
      "",
      "[[package]]",
      'name = "broken"',
      "",
    ].join("\n");
    const r = parseCargoLock(text);
    expect(r.dependencies).toEqual([{ ecosystem: "crates.io", name: "serde", version: "1.0.200" }]);
    expect(r.skipped).toHaveLength(1);
  });

  it("requirements --editable and URL lines are skipped", () => {
    const r = parseRequirements("--editable ./x\nhttps://example.invalid/pkg-1.0.whl\n");
    expect(r.dependencies).toEqual([]);
    expect(r.skipped.map((s) => s.line)).toEqual([1, 2]);
  });

  it("runtime value that is not a string is skipped", () => {
    const r = parseRuntimes({ node: 22 as unknown as string });
    expect(r.dependencies).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });

  it("detect reads requirements_dev.txt and an uppercase name", () => {
    expect(detect("requirements_dev.txt", "")?.parser).toBe("requirements");
    expect(detect("GO.SUM", "")?.parser).toBe("go-sum");
  });
});
