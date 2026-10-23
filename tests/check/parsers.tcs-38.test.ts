/// <reference types="vite/client" />
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  detect,
  detectParser,
  LockfileParseError,
  parseGradleLockfile,
  parseMixLock,
  parseNugetLock,
  parseOsPackages,
  parsePomXml,
  parsePubspecLock,
  SUPPORTED_FILENAMES,
  type Dependency,
  type ParseResult,
} from "../../src/check/parsers";
import apkInstalled from "../fixtures/lockfiles/apk-installed.txt?raw";
import dpkgL from "../fixtures/lockfiles/dpkg-l.txt?raw";
import dpkgQuery from "../fixtures/lockfiles/dpkg-query.txt?raw";
import gradleLockfile from "../fixtures/lockfiles/gradle.lockfile?raw";
import mixLock from "../fixtures/lockfiles/mix.lock?raw";
import packagesLock from "../fixtures/lockfiles/packages.lock.json?raw";
import pomDoubling from "../fixtures/lockfiles/pom-doubling.xml?raw";
import pomXml from "../fixtures/lockfiles/pom.xml?raw";
import pubspecLock from "../fixtures/lockfiles/pubspec.lock?raw";

// TCS-38: one fixture per new file type (tests/fixtures/lockfiles/SOURCES.md
// says where each came from). Each test checks the dependency count, three
// named items and the skip reasons.

const has = (r: ParseResult, d: Dependency) => r.dependencies.some((x) => x.ecosystem === d.ecosystem && x.name === d.name && x.version === d.version);
const reasons = (r: ParseResult) => r.skipped.map((s) => s.reason);

describe("pom.xml (Maven)", () => {
  it("reads the openpdf-parent 1.3.11 POM: dependencies and dependencyManagement, properties resolved, plugin dependencies not read", () => {
    const r = parsePomXml(pomXml);
    expect(r.dependencies).toHaveLength(10);
    expect(has(r, { ecosystem: "Maven", name: "org.bouncycastle:bcprov-jdk15on", version: "1.63" })).toBe(true);
    expect(has(r, { ecosystem: "Maven", name: "org.junit.jupiter:junit-jupiter-api", version: "5.5.1" })).toBe(true);
    expect(has(r, { ecosystem: "Maven", name: "org.assertj:assertj-core", version: "3.12.1" })).toBe(true);
    expect(has(r, { ecosystem: "Maven", name: "org.mockito:mockito-core", version: "2.25.1" })).toBe(true);
    // <build><plugins><plugin><dependencies>: a build plugin's own classpath, not the project's.
    expect(r.dependencies.some((d) => d.name === "org.pitest:pitest-junit5-plugin")).toBe(false);
    expect(r.skipped).toEqual([]);
  });

  it("resolves ${project.version}, skips a parent-managed version and an unresolved property, never guesses", () => {
    const pom = `<?xml version="1.0"?>
<project>
  <parent><groupId>org.example</groupId><artifactId>parent</artifactId><version>9.9.9</version></parent>
  <groupId>org.example</groupId>
  <artifactId>app</artifactId>
  <version>2.0.1</version>
  <properties><lib.version>1.2.3</lib.version><alias.version>\${lib.version}</alias.version></properties>
  <dependencies>
    <!-- <dependency><groupId>commented</groupId><artifactId>out</artifactId><version>1</version></dependency> -->
    <dependency><groupId>\${project.groupId}</groupId><artifactId>core</artifactId><version>\${project.version}</version></dependency>
    <dependency><groupId>org.example</groupId><artifactId>lib</artifactId><version>\${alias.version}</version></dependency>
    <dependency><groupId>org.example</groupId><artifactId>managed</artifactId></dependency>
    <dependency><groupId>org.example</groupId><artifactId>unknown</artifactId><version>\${missing.version}</version></dependency>
    <dependency><groupId>org.example</groupId><artifactId>ranged</artifactId><version>[1.0,2.0)</version></dependency>
  </dependencies>
</project>`;
    const r = parsePomXml(pom);
    expect(r.dependencies).toEqual([
      { ecosystem: "Maven", name: "org.example:core", version: "2.0.1" },
      { ecosystem: "Maven", name: "org.example:lib", version: "1.2.3" },
    ]);
    expect(reasons(r)).toEqual(["no version (managed by a parent)", "unresolved_property", "version range"]);
    expect(r.dependencies.some((d) => d.name.startsWith("commented"))).toBe(false);
  });

  // Round 2 review: ${p} expansion is bounded. A resolved value is at most 256
  // characters and a document resolves at most 200 properties; past either cap
  // the dependency is skipped (unresolved_property), never read as clean.
  const pomWith = (props: string, deps: string) =>
    `<project><groupId>x</groupId><artifactId>x</artifactId><version>1</version><properties>${props}</properties><dependencies>${deps}</dependencies></project>`;
  const dep = (a: string, v: string) => `<dependency><groupId>org.example</groupId><artifactId>${a}</artifactId><version>${v}</version></dependency>`;

  it("a 30-level doubling property chain (tests/fixtures/lockfiles/pom-doubling.xml) parses in under 50 ms and is a skip", () => {
    const t0 = performance.now();
    const r = parsePomXml(pomDoubling);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
    expect(r.dependencies).toEqual([]);
    expect(reasons(r)).toEqual(["unresolved_property"]);
  }, 120_000);

  it("a resolved value over 256 characters is a skip", () => {
    const long = "1".repeat(257);
    const r = parsePomXml(pomWith(`<big>${long}</big><ok>${"1".repeat(256)}</ok>`, dep("big", "${big}") + dep("ok", "${ok}") + dep("lit", long)));
    expect(r.dependencies.map((d) => d.name)).toEqual(["org.example:ok"]);
    expect(reasons(r)).toEqual(["unresolved_property", "unresolved_property"]);
  });

  it("a document that needs more than 200 property expansions is a skip; 200 still resolve", () => {
    const chain = (n: number) => ["<c0>1.0</c0>", ...Array.from({ length: n }, (_, i) => `<c${i + 1}>\${c${i}}</c${i + 1}>`)].join("");
    const over = parsePomXml(pomWith(chain(200), dep("deep", "${c200}")));
    expect(over.dependencies).toEqual([]);
    expect(reasons(over)).toEqual(["unresolved_property"]);
    const at = parsePomXml(pomWith(chain(199), dep("deep", "${c199}")));
    expect(at.dependencies).toEqual([{ ecosystem: "Maven", name: "org.example:deep", version: "1.0" }]);
  });

  it("two levels of properties resolve, and 300 references to one property count it once", () => {
    const deps = Array.from({ length: 300 }, (_, i) => dep(`m${i}`, "${spring.version}")).join("");
    const r = parsePomXml(pomWith("<base.version>5.3.39</base.version><spring.version>${base.version}</spring.version>", deps));
    expect(r.dependencies).toHaveLength(300);
    expect(r.dependencies.every((d) => d.version === "5.3.39")).toBe(true);
    expect(r.skipped).toEqual([]);
  });

  it("a file with no <project> tag is a LockfileParseError", () => {
    expect(() => parsePomXml("<settings></settings>")).toThrow(LockfileParseError);
    expect(() => parsePomXml("")).toThrow(LockfileParseError);
  });
});

describe("gradle.lockfile (Maven)", () => {
  it("reads group:artifact:version lines, ignores comments and empty=", () => {
    const r = parseGradleLockfile(gradleLockfile);
    expect(r.dependencies).toHaveLength(9);
    expect(has(r, { ecosystem: "Maven", name: "org.apache.logging.log4j:log4j-core", version: "2.14.1" })).toBe(true);
    expect(has(r, { ecosystem: "Maven", name: "com.fasterxml.jackson.core:jackson-databind", version: "2.13.4.1" })).toBe(true);
    expect(has(r, { ecosystem: "Maven", name: "junit:junit", version: "4.13.2" })).toBe(true);
    expect(r.skipped).toEqual([]);
  });

  it("skips a line that is not a lock line; a file with no lock line is a LockfileParseError", () => {
    const r = parseGradleLockfile("org.a:b:1.0=runtimeClasspath\nnot a lock line\n");
    expect(r.dependencies).toEqual([{ ecosystem: "Maven", name: "org.a:b", version: "1.0" }]);
    expect(r.skipped).toEqual([{ line: 2, raw: "not a lock line", reason: "not a lock line" }]);
    expect(() => parseGradleLockfile("{\"not\": \"gradle\"}")).toThrow(LockfileParseError);
  });
});

describe("packages.lock.json (NuGet)", () => {
  it("reads resolved versions of every framework, dedups, skips project references", () => {
    const r = parseNugetLock(packagesLock);
    expect(r.dependencies).toHaveLength(5);
    expect(has(r, { ecosystem: "NuGet", name: "Newtonsoft.Json", version: "12.0.3" })).toBe(true);
    expect(has(r, { ecosystem: "NuGet", name: "Serilog", version: "3.1.1" })).toBe(true);
    expect(has(r, { ecosystem: "NuGet", name: "System.Text.Encodings.Web", version: "4.5.0" })).toBe(true);
    expect(reasons(r)).toEqual(["project reference", "project reference"]);
  });

  it("not JSON, or no dependencies object: LockfileParseError", () => {
    expect(() => parseNugetLock("{oops")).toThrow(LockfileParseError);
    expect(() => parseNugetLock('{"version":1}')).toThrow(LockfileParseError);
    expect(() => parseNugetLock("[]")).toThrow(LockfileParseError);
  });
});

describe("mix.lock (Hex)", () => {
  it("reads :hex entries by the package atom, skips :git", () => {
    const r = parseMixLock(mixLock);
    expect(r.dependencies).toHaveLength(8);
    expect(has(r, { ecosystem: "Hex", name: "plug", version: "1.3.5" })).toBe(true);
    expect(has(r, { ecosystem: "Hex", name: "phoenix", version: "1.7.10" })).toBe(true);
    // The lock key is jose_fork; the Hex package is :jose.
    expect(has(r, { ecosystem: "Hex", name: "jose", version: "1.11.6" })).toBe(true);
    expect(reasons(r)).toEqual(["not from hex"]);
  });

  it("a file that is not a mix.lock map is a LockfileParseError", () => {
    expect(() => parseMixLock("")).toThrow(LockfileParseError);
    expect(() => parseMixLock('{"a": 1}')).toThrow(LockfileParseError);
  });
});

describe("pubspec.lock (Pub)", () => {
  it("reads hosted packages, skips sdk, git and path sources", () => {
    const r = parsePubspecLock(pubspecLock);
    expect(r.dependencies).toHaveLength(4);
    expect(has(r, { ecosystem: "Pub", name: "http", version: "0.13.2" })).toBe(true);
    expect(has(r, { ecosystem: "Pub", name: "dio", version: "5.0.0" })).toBe(true);
    expect(has(r, { ecosystem: "Pub", name: "sqflite", version: "2.2.8+3" })).toBe(true);
    expect(reasons(r).sort()).toEqual(["not hosted", "not hosted", "not hosted"]);
  });

  it("a file with no packages: map is a LockfileParseError", () => {
    expect(() => parsePubspecLock("")).toThrow(LockfileParseError);
    expect(() => parsePubspecLock("sdks:\n  dart: \">=3.0.0\"\n")).toThrow(LockfileParseError);
  });
});

describe("OS package lists", () => {
  it("apk list --installed (Alpine 3.15.4): name = origin, version = <ver>-r<N>, deduped on origin and version", () => {
    const r = parseOsPackages("alpine", "3.15.4", apkInstalled);
    // 14 packages; 3 origins (openssl, musl, busybox) appear twice with one version: 11 dependencies.
    expect(r.dependencies).toHaveLength(11);
    expect(has(r, { ecosystem: "Alpine:v3.15", name: "openssl", version: "1.1.1n-r0" })).toBe(true);
    expect(has(r, { ecosystem: "Alpine:v3.15", name: "ca-certificates", version: "20211220-r0" })).toBe(true);
    expect(has(r, { ecosystem: "Alpine:v3.15", name: "pax-utils", version: "1.3.3-r0" })).toBe(true);
    expect(r.dependencies.some((d) => d.name === "libcrypto1.1")).toBe(false);
    expect(r.skipped).toEqual([]);
  });

  it("dpkg-query -W source form: name = source package", () => {
    const r = parseOsPackages("debian", "12", dpkgQuery);
    expect(r.dependencies).toHaveLength(6);
    expect(has(r, { ecosystem: "Debian:12", name: "audit", version: "1:2.8.2-1ubuntu1" })).toBe(true);
    expect(has(r, { ecosystem: "Debian:12", name: "systemd", version: "237-3ubuntu10.22" })).toBe(true);
    expect(has(r, { ecosystem: "Debian:12", name: "apt", version: "1.6.11" })).toBe(true);
  });

  // Round 2 review: dpkg -l prints binary package names (libaudit1, perl-base);
  // OSV Debian names source packages (audit, perl). The parser has no
  // binary-to-source map, so every dpkg -l row is skipped, never read as clean.
  it("dpkg -l: every installed row is skipped as binary_package_name, header lines ignored", () => {
    const r = parseOsPackages("debian", "12.5", dpkgL);
    expect(r.dependencies).toEqual([]);
    expect(reasons(r)).toEqual(Array(6).fill("binary_package_name"));
    expect(r.skipped[0]).toMatchObject({ line: 6, reason: "binary_package_name" });
    expect(r.skipped[0].raw.startsWith("ii  libapt-pkg5.0")).toBe(true);
    const extra = parseOsPackages("debian", "12", "ii  libc6:amd64  2.36-9+deb12u4  amd64  GNU C Library\nrc  oldpkg  1.0-1  amd64  removed\n");
    expect(extra.dependencies).toEqual([]);
    expect(extra.skipped).toEqual([
      { line: 1, raw: "ii  libc6:amd64  2.36-9+deb12u4  amd64  GNU C Library", reason: "binary_package_name" },
      { line: 2, raw: "rc  oldpkg  1.0-1  amd64  removed", reason: "not installed" },
    ]);
  });

  it("normalizes the release; a bad release, an empty list or a list with no package line is a LockfileParseError", () => {
    for (const rel of ["3.18", "v3.18", "3.18.4"]) {
      expect(parseOsPackages("alpine", rel, "musl-1.2.4-r2 x86_64 {musl} (MIT) [installed]").dependencies[0].ecosystem).toBe("Alpine:v3.18");
    }
    for (const rel of ["", "edge", "3", "bookworm", "v3"]) {
      expect(() => parseOsPackages("alpine", rel, "musl-1.2.4-r2 x86_64 {musl} (MIT) [installed]"), rel).toThrow(LockfileParseError);
    }
    for (const rel of ["", "bookworm", "12a", "v12"]) {
      expect(() => parseOsPackages("debian", rel, "openssl 3.0.11-1~deb12u2"), rel).toThrow(LockfileParseError);
    }
    expect(() => parseOsPackages("debian", "12", "")).toThrow(LockfileParseError);
    expect(() => parseOsPackages("debian", "12", "   \n")).toThrow(LockfileParseError);
    expect(() => parseOsPackages("alpine", "3.18", "hello world, not a package list")).toThrow(LockfileParseError);
  });
});

describe("detectParser and the check route", () => {
  it("knows the five new names, case-insensitive", () => {
    expect(detectParser("pom.xml")).toBe("pom-xml");
    expect(detectParser("POM.XML")).toBe("pom-xml");
    expect(detectParser("app/gradle.lockfile")).toBe("gradle-lockfile");
    expect(detectParser("packages.lock.json")).toBe("nuget-lock");
    expect(detectParser("mix.lock")).toBe("mix-lock");
    expect(detectParser("pubspec.lock")).toBe("pubspec-lock");
    expect(detectParser("pubspec.yaml")).toBeNull();
    for (const n of ["pom.xml", "gradle.lockfile", "packages.lock.json", "mix.lock", "pubspec.lock"]) expect(SUPPORTED_FILENAMES).toContain(n);
    expect(detect("mix.lock", mixLock)?.result.dependencies).toHaveLength(8);
  });

  it("POST /v1/check multipart: each fixture is read; a broken file answers 400 that names the file", async () => {
    const form = new FormData();
    form.append("pom.xml", pomXml);
    form.append("gradle.lockfile", gradleLockfile);
    form.append("packages.lock.json", packagesLock);
    form.append("mix.lock", mixLock);
    form.append("pubspec.lock", pubspecLock);
    const res = await exports.default.fetch("https://tocsin.test/v1/check", { method: "POST", headers: { "CF-Connecting-IP": "192.0.2.138" }, body: form });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { checked: number; skipped: { file?: string; reason: string }[] };
    expect(body.checked).toBe(10 + 9 + 5 + 8 + 4);
    expect(body.skipped.filter((s) => s.file === "mix.lock").map((s) => s.reason)).toEqual(["not from hex"]);

    for (const name of ["pom.xml", "packages.lock.json", "mix.lock", "pubspec.lock", "gradle.lockfile"]) {
      const bad = new FormData();
      bad.append(name, "{oops");
      const r = await exports.default.fetch("https://tocsin.test/v1/check", { method: "POST", headers: { "CF-Connecting-IP": "192.0.2.139" }, body: bad });
      expect(r.status, name).toBe(400);
      expect(((await r.json()) as { file: string }).file).toBe(name);
    }
  });
});
