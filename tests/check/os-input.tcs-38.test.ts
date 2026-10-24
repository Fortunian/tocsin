/// <reference types="vite/client" />
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { OsvVuln } from "../../src/ingest/osv";
import alpineAssumed from "../fixtures/osv/tcs-38/alpine.assumed.json";
import apkInstalled from "../fixtures/lockfiles/apk-installed.txt?raw";
import dpkgL from "../fixtures/lockfiles/dpkg-l.txt?raw";
import dpkgQuery from "../fixtures/lockfiles/dpkg-query.txt?raw";
import mixLock from "../fixtures/lockfiles/mix.lock?raw";

// TCS-38: /v1/check takes an OS package list as runtime-style input:
// JSON runtimes.alpine / runtimes.debian (the release) plus a top-level
// os_packages text, or multipart fields alpine / debian plus os_packages.
// Every request goes through the production entry (src/index.ts) with its own
// client IP (RFC 5737), and the advisories are stored through the import route.

const TOKEN = "tok-fixture-import-38os";

interface Answer {
  checked: number;
  affected: { dependency: { ecosystem: string; name: string; version: string }; advisory_id: string; fixed_in: string | null }[];
  skipped: { dependency?: { ecosystem: string; name: string }; reason: string; raw?: string; file?: string }[];
  coverage: { ecosystem: string; complete: boolean }[];
}

function osRecord(id: string, ecosystem: string, name: string, fixed: string): OsvVuln {
  return {
    id,
    modified: "2026-10-23T00:00:00Z",
    published: "2026-10-23T00:00:00Z",
    summary: `Hand-built TCS-38 test record ${id}.`,
    affected: [{ package: { ecosystem, name }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed }] }] }],
  };
}

async function importPost(ecosystem: string, records: OsvVuln[]): Promise<void> {
  const e = { ...env, IMPORT_TOKEN: TOKEN } as typeof env & { IMPORT_TOKEN: string };
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://tocsin.test/v1/internal/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ecosystem, records, skipped: 0, last_id: records[records.length - 1].id, start: true }),
    }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(((await res.json()) as { errors: string[] }).errors).toEqual([]);
}

const postJson = (ip: string, body: unknown) =>
  exports.default.fetch("https://tocsin.test/v1/check", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const postForm = (ip: string, fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return exports.default.fetch("https://tocsin.test/v1/check", { method: "POST", headers: { "CF-Connecting-IP": ip }, body: form });
};

async function ok(res: Response): Promise<Answer> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Answer;
}

async function bad(res: Response): Promise<{ error: string; field?: string }> {
  expect(res.status, await res.clone().text()).toBe(400);
  return (await res.json()) as { error: string; field?: string };
}

beforeAll(async () => {
  // Alpine: openssl fixed in 1.1.1t-r0 on v3.15 and 1.1.1t-r1 on v3.16 (assumed record).
  await importPost("Alpine", [structuredClone((alpineAssumed as unknown as OsvVuln[]).find((r) => r.id === "TCS38-ALPINE-01")!)]);
  // Debian 12: the source package audit and the binary package perl-base.
  await importPost("Debian", [osRecord("TCS38-OS-DEB-1", "Debian:12", "audit", "1:2.8.2-1ubuntu2"), osRecord("TCS38-OS-DEB-2", "Debian:12", "perl-base", "5.22.1-9ubuntu0.10")]);
});

describe("POST /v1/check JSON with an OS package list", () => {
  it("apk list --installed with alpine=3.15 reports libcrypto1.1/libssl1.1 under their origin openssl", async () => {
    const a = await ok(await postJson("192.0.2.201", { runtimes: { alpine: "3.15" }, os_packages: apkInstalled }));
    expect(a.checked).toBe(11);
    expect(a.affected.map((x) => [x.dependency, x.fixed_in])).toEqual([[{ ecosystem: "Alpine:v3.15", name: "openssl", version: "1.1.1n-r0" }, "1.1.1t-r0"]]);
    expect(a.coverage).toMatchObject([{ ecosystem: "Alpine:v3.15", complete: false }]);
    expect(a.skipped.some((s) => s.reason === "unknown runtime")).toBe(false);
  });

  it("the same list with alpine=3.17 does not match the v3.15 or v3.16 docs", async () => {
    const a = await ok(await postJson("192.0.2.202", { runtimes: { alpine: "v3.17" }, os_packages: apkInstalled }));
    expect(a.affected).toEqual([]);
    expect(a.skipped.filter((s) => s.reason === "partial_coverage")).toHaveLength(11);
  });

  it("dpkg-query source form with debian=12 matches the source package audit", async () => {
    const a = await ok(await postJson("192.0.2.203", { runtimes: { debian: "12" }, os_packages: dpkgQuery }));
    expect(a.checked).toBe(6);
    expect(a.affected.map((x) => [x.dependency, x.fixed_in])).toEqual([[{ ecosystem: "Debian:12", name: "audit", version: "1:2.8.2-1ubuntu1" }, "1:2.8.2-1ubuntu2"]]);
  });

  it("dpkg -l binary form is skipped as binary_package_name, never clean; node and debian together; debian is not an unknown runtime", async () => {
    const a = await ok(await postJson("192.0.2.204", { runtimes: { debian: "12.5", node: "24.22.0" }, os_packages: dpkgL }));
    expect(a.checked).toBe(1);
    expect(a.affected.filter((x) => x.dependency.ecosystem === "Debian:12")).toEqual([]);
    const binary = a.skipped.filter((s) => s.reason === "binary_package_name");
    expect(binary).toHaveLength(6);
    expect(binary.every((s) => s.file === "os_packages")).toBe(true);
    expect(a.skipped.filter((s) => s.reason === "unknown runtime")).toEqual([]);
    expect(a.coverage.map((c) => c.ecosystem)).toEqual(["node"]);
  });

  it("a bare Debian dependency in dependencies[] is unsupported_ecosystem, never clean", async () => {
    const a = await ok(await postJson("192.0.2.205", { dependencies: [{ ecosystem: "Debian", name: "audit", version: "1:2.8.2-1ubuntu1" }] }));
    expect(a.checked).toBe(0);
    expect(a.skipped).toEqual([{ dependency: { ecosystem: "Debian", name: "audit", version: "1:2.8.2-1ubuntu1" }, reason: "unsupported_ecosystem" }]);
  });

  it("answers 400 naming the field: release without list, list without release, both OSes, bad release, empty list", async () => {
    expect((await bad(await postJson("192.0.2.206", { runtimes: { debian: "12" } }))).field).toBe("os_packages");
    expect((await bad(await postJson("192.0.2.206", { os_packages: dpkgQuery }))).field).toBe("os_packages");
    expect((await bad(await postJson("192.0.2.206", { runtimes: { debian: "12", alpine: "3.18" }, os_packages: dpkgQuery }))).field).toBe("alpine");
    expect((await bad(await postJson("192.0.2.206", { runtimes: { debian: "bookworm" }, os_packages: dpkgQuery }))).field).toBe("debian");
    expect((await bad(await postJson("192.0.2.206", { runtimes: { debian: 12 }, os_packages: dpkgQuery }))).field).toBe("debian");
    expect((await bad(await postJson("192.0.2.206", { runtimes: { debian: "12" }, os_packages: "" }))).field).toBe("os_packages");
    expect((await bad(await postJson("192.0.2.206", { runtimes: { debian: "12" }, os_packages: ["openssl 1.0"] }))).field).toBe("os_packages");
  });
});

describe("POST /v1/check multipart with an OS package list", () => {
  it("fields alpine and os_packages, next to a lockfile: both are checked in one answer", async () => {
    const a = await ok(await postForm("192.0.2.207", { alpine: "3.15.4", os_packages: apkInstalled, "mix.lock": mixLock }));
    expect(a.checked).toBe(11 + 8);
    expect(a.affected.map((x) => x.dependency.name)).toEqual(["openssl"]);
    expect(a.coverage.map((c) => c.ecosystem)).toEqual(["Alpine:v3.15", "Hex"]);
  });

  it("only OS fields (no lockfile) are enough", async () => {
    const a = await ok(await postForm("192.0.2.208", { debian: "12", os_packages: dpkgQuery }));
    expect(a.checked).toBe(6);
  });

  it("answers 400 naming the field", async () => {
    expect((await bad(await postForm("192.0.2.209", { debian: "12" }))).field).toBe("os_packages");
    expect((await bad(await postForm("192.0.2.209", { os_packages: dpkgQuery }))).field).toBe("os_packages");
    expect((await bad(await postForm("192.0.2.209", { debian: "12", alpine: "3.18", os_packages: dpkgQuery }))).field).toBe("alpine");
    expect((await bad(await postForm("192.0.2.209", { alpine: "edge", os_packages: apkInstalled }))).field).toBe("alpine");
  });
});

describe("GET /v1/check with an OS release", () => {
  it("?debian=12 answers 400 that names os_packages", async () => {
    const res = await exports.default.fetch("https://tocsin.test/v1/check?debian=12", { headers: { "CF-Connecting-IP": "192.0.2.210" } });
    const body = await bad(res);
    expect(body.error).toBe("debian= needs os_packages; send it with POST /v1/check");
    const res2 = await exports.default.fetch("https://tocsin.test/v1/check?node=24.22.0&alpine=3.18", { headers: { "CF-Connecting-IP": "192.0.2.210" } });
    expect((await bad(res2)).error).toBe("alpine= needs os_packages; send it with POST /v1/check");
  });
});
