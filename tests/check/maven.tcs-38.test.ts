import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { matchAdvisory, supportsEcosystem } from "../../src/check/match";
import { mavenComparator } from "../../src/check/match/maven";
import worker from "../../src/index";
import type { OsvVuln } from "../../src/ingest/osv";
import r29qj from "../fixtures/osv/tcs-38/Maven/GHSA-29qj-rvv6-qrmv.json";
import r2hjr from "../fixtures/osv/tcs-38/Maven/GHSA-2hjr-vmf3-xwvp.json";
import r76mp from "../fixtures/osv/tcs-38/Maven/GHSA-76mp-659p-rw65.json";
import r8hxh from "../fixtures/osv/tcs-38/Maven/GHSA-8hxh-r6f7-jf45.json";
import rmr95 from "../fixtures/osv/tcs-38/Maven/GHSA-mr95-9rr4-668f.json";
import assumed from "../fixtures/osv/tcs-38/maven.assumed.json";
import { expectAscending, expectInvalid, expectRecordCases } from "./ecosystem-cases.tcs-38";

// TCS-38: Maven uses ComparableVersion order (maven-artifact). The order
// tables below are the ones in Maven's own ComparableVersionTest
// (VERSIONS_QUALIFIER, VERSIONS_NUMBER and the equality checks).

describe("Maven comparator", () => {
  it("orders qualifiers: alpha < beta < milestone < rc = cr < snapshot < release < sp < unknown", () => {
    expectAscending(mavenComparator, [
      "1-alpha2snapshot",
      "1-alpha2",
      "1-alpha-123",
      "1-beta-2",
      "1-beta123",
      "1-m2",
      "1-m11",
      "1-rc",
      "1-cr2",
      "1-rc123",
      "1-SNAPSHOT",
      ["1", "1.0", "1.0.0", "1-ga", "1-final", "1-release", "1GA", "1.0.0-GA"],
      "1-sp",
      "1-sp2",
      "1-sp123",
      "1-abc",
      "1-def",
      "1-pom-1",
      "1-1-snapshot",
      "1-1",
      "1-2",
      "1-123",
    ]);
  });

  it("orders numbers and number/letter transitions", () => {
    expectAscending(mavenComparator, [
      "2.0",
      "2-1",
      "2.0.a",
      "2.0.0.a",
      "2.0.2",
      "2.0.123",
      "2.1.0",
      "2.1-a",
      "2.1b",
      "2.1-c",
      "2.1-1",
      "2.1.0.1",
      "2.2",
      "2.123",
      "11.a2",
      "11.a11",
      "11.b2",
      "11.b11",
      "11.m2",
      "11.m11",
      "11",
      "11.a",
      "11b",
      "11c",
      "11m",
    ]);
  });

  it("pins the ticket edge cases: 1.2.3-SNAPSHOT < 1.2.3, RC1 = rc1, 1.0-sp1 > 1.0, aliases", () => {
    expectAscending(mavenComparator, [
      "1.2.2",
      ["1.2.3-RC1", "1.2.3-rc1", "1.2.3-cr1"],
      "1.2.3-SNAPSHOT",
      ["1.2.3", "1.2.3.0", "1.2.3-final"],
      "1.2.3-sp1",
      "1.2.4",
    ]);
    expectAscending(mavenComparator, [["1a1", "1-alpha-1", "1-a1", "1.0-ALPHA1"], ["1b2", "1-beta-2"], ["1m3", "1-milestone-3"]]);
    expectAscending(mavenComparator, ["2.0-beta9", "2.0", "2.14.1", "2.15.0", "2.16.0", "2.17.1"]);
  });

  it("rejects an empty or spaced version and a leading v", () => {
    expectInvalid(mavenComparator, ["", " ", "v1.0", "1.0 beta", "abc", "[1.0,2.0)", "${log4j.version}"]);
  });

  it("is registered as Maven, exact name; a suffix on Maven is not a release", () => {
    expect(supportsEcosystem("Maven")).toBe(true);
    expect(supportsEcosystem("maven")).toBe(false);
    expect(supportsEcosystem("Maven:https://repo.example/x")).toBe(false);
    const adv = {
      id: "tcs_TCS38MAVEN00000000000000",
      ecosystem: "Maven",
      component: "org.example:lib",
      affected: [{ introduced: "2.0-beta9", fixed: "2.15.0" }],
      fixed_versions: ["2.15.0"],
    } as never;
    expect(matchAdvisory({ ecosystem: "Maven", name: "org.example:lib", version: "2.15.0-rc1" }, adv)).toEqual({ affected: true, fixed_in: "2.15.0" });
    expect(matchAdvisory({ ecosystem: "Maven", name: "org.example:lib", version: "2.0-beta8" }, adv)).toEqual({ affected: false });
    // Negative: npm dependency of the same name; Maven with a suffix.
    expect(matchAdvisory({ ecosystem: "npm", name: "org.example:lib", version: "2.14.1" }, adv)).toEqual({ affected: false });
    expect(matchAdvisory({ ecosystem: "Maven:https://x", name: "org.example:lib", version: "2.14.1" }, adv).affected).toBe(false);
  });
});

// 10 OSV records (tests/fixtures/osv/tcs-38/SOURCES.md): 5 recorded GHSA
// copies, 5 hand-built (maven.assumed.json, incl. the log4j record of Task 9).
const RECORDS = [r76mp, rmr95, r2hjr, r8hxh, r29qj, ...assumed] as unknown as OsvVuln[];

describe("Maven: 10 OSV records, one version inside and one outside each range", () => {
  it("matches each record through normalizeOsv and matchAdvisory", () => {
    expectRecordCases(RECORDS, ["Maven"], [
      { id: "GHSA-76mp-659p-rw65", dep: "Maven", name: "org.xwiki.commons:xwiki-commons-core", affected: "12.10.1", notAffected: "12.8", fixed_in: "12.10.2" },
      { id: "GHSA-mr95-9rr4-668f", dep: "Maven", name: "com.typesafe.akka:akka-actor_2.12", affected: "2.5.15", notAffected: "2.5.16", fixed_in: "2.5.16" },
      { id: "GHSA-2hjr-vmf3-xwvp", dep: "Maven", name: "org.elasticsearch:elasticsearch", affected: "8.11.1", notAffected: "7.17.16", fixed_in: "8.11.2" },
      { id: "GHSA-8hxh-r6f7-jf45", dep: "Maven", name: "org.http4s:http4s-async-http-client_2.13", affected: "0.21.7", notAffected: "0.21.8", fixed_in: "0.21.8" },
      { id: "GHSA-29qj-rvv6-qrmv", dep: "Maven", name: "org.jboss.resteasy:resteasy-core", affected: "4.5.2.Final", notAffected: "4.5.3.Final", fixed_in: "4.5.3.Final" },
      { id: "GHSA-jfh8-c2jp-5v3q", dep: "Maven", name: "org.apache.logging.log4j:log4j-core", affected: "2.0-rc1", notAffected: "2.12.2", fixed_in: "2.3.1" },
      { id: "TCS38-MAVEN-02", dep: "Maven", name: "org.springframework:spring-beans", affected: "5.2.19.RELEASE", notAffected: "5.3.18", fixed_in: "5.2.20.RELEASE" },
      { id: "TCS38-MAVEN-03", dep: "Maven", name: "com.fasterxml.jackson.core:jackson-databind", affected: "2.12.7", notAffected: "2.13.4.2", fixed_in: "2.12.7.1" },
      { id: "TCS38-MAVEN-04", dep: "Maven", name: "org.yaml:snakeyaml", affected: "1.33", notAffected: "2.0", fixed_in: null },
      { id: "TCS38-MAVEN-05", dep: "Maven", name: "org.apache.commons:commons-text", affected: "1.10.0-SNAPSHOT", notAffected: "1.4", fixed_in: "1.10.0" },
    ]);
  });
});

// Task 9: the log4j record through the production entry points: the import
// route stores it, then POST /v1/check answers CVE-2021-44228 for 2.14.1.
describe("log4j through POST /v1/internal/import and POST /v1/check", () => {
  const TOKEN = "tok-fixture-import-38";
  const log4j = (assumed as unknown as OsvVuln[]).find((r) => r.id === "GHSA-jfh8-c2jp-5v3q")!;

  async function importPost(body: unknown): Promise<Response> {
    const e = { ...env, IMPORT_TOKEN: TOKEN } as typeof env & { IMPORT_TOKEN: string };
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://tocsin.test/v1/internal/import", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      e,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  async function check(version: string, ip: string) {
    const res = await exports.default.fetch("https://tocsin.test/v1/check", {
      method: "POST",
      headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
      body: JSON.stringify({ dependencies: [{ ecosystem: "Maven", name: "org.apache.logging.log4j:log4j-core", version }] }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { affected: { advisory_id: string; cve_ids: string[]; fixed_in: string | null }[]; coverage: { ecosystem: string }[] };
  }

  it("log4j: import, then log4j-core 2.14.1 returns CVE-2021-44228 fixed in 2.15.0; 2.17.1 does not", async () => {
    const res = await importPost({ ecosystem: "Maven", records: [log4j], skipped: 0, last_id: log4j.id, start: true });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ ecosystem: "Maven", imported: 1, errors: [] });

    const hit = await check("2.14.1", "192.0.2.181");
    expect(hit.affected).toHaveLength(1);
    expect(hit.affected[0].cve_ids).toContain("CVE-2021-44228");
    expect(hit.affected[0].fixed_in).toBe("2.15.0");
    expect(hit.coverage.map((c) => c.ecosystem)).toEqual(["Maven"]);

    const clean = await check("2.17.1", "192.0.2.182");
    expect(clean.affected).toEqual([]);
  });
});
