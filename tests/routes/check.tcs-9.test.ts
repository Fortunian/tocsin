import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Advisory, AffectedRange, SeverityLabel } from "../../src/schema/advisory";
import { validateAdvisory } from "../../src/schema/advisory";
import validateWellKnown from "../../src/schema/well-known.validate.generated.js";
import nodeFixture from "../fixtures/advisory/valid.json";
import lockfile from "../fixtures/check/package-lock.tcs-9.json";
import { get, idFor } from "./seed.tcs-3";

// Every request goes through the production entry (src/index.ts). This file
// seeds its own rows (idFor prefix "C9") once, and every test sends its own
// client IP (RFC 5737), so rate-limit counters never couple.

interface Affected {
  dependency: { ecosystem: string; name: string; version: string };
  advisory_id: string;
  cve_ids: string[];
  severity: { score?: number; label: SeverityLabel };
  exploited: boolean;
  fixed_in: string | null;
  action: string;
  url: string;
}
interface CheckAnswer {
  checked: number;
  affected: Affected[];
  skipped: Array<Record<string, unknown>>;
  feed_cursor: number;
}

const BASE_CURSOR = 900_001;
let seededMaxCursor = 0;
let nodeId = "";
let phpId = "";

interface Spec {
  ecosystem: string;
  component: string;
  affected: AffectedRange[];
  label: SeverityLabel;
  exploited?: boolean;
  cve?: string;
}

function docFrom(id: string, s: Spec): Advisory {
  const doc = structuredClone(nodeFixture) as Advisory;
  doc.id = id;
  doc.ecosystem = s.ecosystem;
  doc.component = s.component;
  doc.affected = s.affected;
  doc.fixed_versions = s.affected.flatMap((r) => (r.fixed ? [r.fixed] : []));
  doc.severity = { score: 7, label: s.label };
  doc.exploited = s.exploited ?? false;
  doc.cve_ids = s.cve ? [s.cve] : [];
  doc.action = `Upgrade ${s.component}.`;
  doc.sources = [{ source: "osv", source_id: id, url: `https://example.com/fixture/${id}` }];
  return doc;
}

async function insert(docs: Advisory[]): Promise<void> {
  const stmt = env.DB.prepare(
    `INSERT INTO advisories (id, cve_primary, ecosystem, component, severity_label, exploited, published_at, modified_at, doc_json, cursor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stmts = docs.map((d, i) => {
    const v = validateAdvisory(d);
    if (!v.ok) throw new Error(`seed doc invalid: ${v.errors.join("; ")}`);
    seededMaxCursor = BASE_CURSOR + i;
    return stmt.bind(
      d.id,
      d.cve_ids[0] ?? null,
      d.ecosystem,
      d.component,
      d.severity.label,
      d.exploited ? 1 : 0,
      d.published_at,
      d.modified_at,
      JSON.stringify(d),
      BASE_CURSOR + i,
    );
  });
  await env.DB.batch(stmts);
}

const below = (fixed: string): AffectedRange[] => [{ introduced: "0", fixed }];

beforeAll(async () => {
  const docs: Advisory[] = [];
  let n = 0;
  const add = (s: Spec) => {
    const d = docFrom(idFor("C9", n++), s);
    docs.push(d);
    return d.id;
  };
  // The 2026-10-21 node advisory, verbatim from the fixture except its id.
  const node = structuredClone(nodeFixture) as Advisory;
  node.id = idFor("C9", n++);
  nodeId = node.id;
  docs.push(node);
  // The 2026-10-21 php advisory (docs/PLAN_2026-10-21.html): fixed in 8.5.12, 8.4.27, 8.3.36, 8.2.35, score 9.2.
  const php = docFrom(idFor("C9", n++), {
    ecosystem: "php",
    component: "php",
    cve: "CVE-2026-109618",
    label: "critical",
    affected: [
      { introduced: "8.2.0", fixed: "8.2.35" },
      { introduced: "8.3.0", fixed: "8.3.36" },
      { introduced: "8.4.0", fixed: "8.4.27" },
      { introduced: "8.5.0", fixed: "8.5.12" },
    ],
  });
  php.severity = { score: 9.2, label: "critical" };
  phpId = php.id;
  docs.push(php);
  // 3 npm advisories: the lockfile's affected package, its safe package, and one package not in it.
  add({ ecosystem: "npm", component: "tcs9-vuln-fixture", affected: below("1.2.4"), label: "medium", cve: "CVE-2026-900001" });
  add({ ecosystem: "npm", component: "tcs9-safe-fixture", affected: below("2.0.0"), label: "critical" });
  add({ ecosystem: "npm", component: "tcs9-absent-fixture", affected: below("9.0.0"), label: "critical" });
  // A same-named package in another ecosystem must not match an npm dependency.
  add({ ecosystem: "PyPI", component: "tcs9-vuln-fixture", affected: below("99.0"), label: "critical" });
  // Sort: high, critical, critical + exploited on 3 packages.
  add({ ecosystem: "npm", component: "tcs9-sort-high", affected: below("2.0.0"), label: "high" });
  add({ ecosystem: "npm", component: "tcs9-sort-crit", affected: below("2.0.0"), label: "critical" });
  add({ ecosystem: "npm", component: "tcs9-sort-critx", affected: below("2.0.0"), label: "critical", exploited: true });
  // Chunking: one vulnerable package far into a 450-key request.
  add({ ecosystem: "npm", component: "tcs9-bulk-420", affected: below("1.0.1"), label: "low" });
  // PyPI name normalization: the advisory component is the normalized name.
  add({ ecosystem: "PyPI", component: "django", affected: below("5.0.0"), label: "high" });
  await insert(docs);
});

function post(ip: string, body: BodyInit, contentType?: string): Promise<Response> {
  const headers: Record<string, string> = { "CF-Connecting-IP": ip };
  if (contentType) headers["Content-Type"] = contentType;
  return exports.default.fetch("https://tocsin.test/v1/check", { method: "POST", headers, body });
}

function postJson(ip: string, body: unknown): Promise<Response> {
  return post(ip, JSON.stringify(body), "application/json");
}

async function ok(res: Response): Promise<CheckAnswer> {
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as CheckAnswer;
}

function lockForm(name = "package-lock.json", text = JSON.stringify(lockfile)): FormData {
  const form = new FormData();
  form.append(name, new File([text], name, { type: "application/json" }));
  return form;
}

describe("POST /v1/check (multipart lockfile)", () => {
  it("package-lock fixture: one affected with fixed_in, the safe package is clean", async () => {
    const body = await ok(await post("192.0.2.1", lockForm()));
    expect(body.checked).toBe(2);
    expect(body.affected).toHaveLength(1);
    const item = body.affected[0];
    expect(item.dependency).toEqual({ ecosystem: "npm", name: "tcs9-vuln-fixture", version: "1.2.3" });
    expect(item.advisory_id).toBe(idFor("C9", 2));
    expect(item.cve_ids).toEqual(["CVE-2026-900001"]);
    expect(item.severity.label).toBe("medium");
    expect(item.exploited).toBe(false);
    expect(item.fixed_in).toBe("1.2.4");
    expect(item.action).toBe("Upgrade tcs9-vuln-fixture.");
    expect(item.url).toBe(`https://example.com/fixture/${idFor("C9", 2)}`);
    expect(typeof body.feed_cursor).toBe("number");
  });

  it("unknown lockfile name answers 400 with the supported filenames", async () => {
    for (const name of ["deps.lock", "bom.json"]) {
      const res = await post("192.0.2.2", lockForm(name));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; file: string; supported_filenames: string[] };
      expect(body.file).toBe(name);
      expect(body.supported_filenames).toContain("package-lock.json");
      expect(body.supported_filenames).toContain("requirements-*.txt");
    }
  });

  it("an unparseable lockfile with a known name answers 400 naming the file", async () => {
    const res = await post("192.0.2.3", lockForm("package-lock.json", "{not json"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; file: string };
    expect(body.file).toBe("package-lock.json");
    expect(body.error).toContain("invalid JSON");
  });

  it("a multipart body with no entries answers 400", async () => {
    const res = await post("192.0.2.4", new FormData());
    expect(res.status).toBe(400);
  });

  it("a 3 MB body answers 413 before any parse", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const res = await post("192.0.2.5", big, "application/json");
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(((await res.json()) as { error: string }).error).toMatch(/body over 2097152 bytes/);
  });

  it("a body of exactly 2 MB is accepted", async () => {
    const shell = JSON.stringify({ dependencies: [], pad: "" });
    const pad = "x".repeat(2 * 1024 * 1024 - shell.length);
    const text = JSON.stringify({ dependencies: [], pad });
    expect(text.length).toBe(2 * 1024 * 1024);
    const body = await ok(await post("192.0.2.6", text, "application/json"));
    expect(body.checked).toBe(0);
  });

  it("another content type answers 415", async () => {
    const res = await post("192.0.2.7", "node=24.22.0", "text/plain");
    expect(res.status).toBe(415);
    const body = (await res.json()) as { accepted: string[] };
    expect(body.accepted).toEqual(["multipart/form-data", "application/json"]);
  });
});

describe("GET /v1/check (runtimes shortcut)", () => {
  it("node=24.22.0 is affected by CVE-2026-111497, fixed in 24.22.1", async () => {
    const body = await ok(await get("/v1/check?node=24.22.0", "192.0.2.10"));
    expect(body.checked).toBe(1);
    expect(body.affected).toHaveLength(1);
    expect(body.affected[0].advisory_id).toBe(nodeId);
    expect(body.affected[0].cve_ids).toContain("CVE-2026-111497");
    expect(body.affected[0].fixed_in).toBe("24.22.1");
    expect(body.affected[0].url).toBe("https://example.com/fixture/node-advisory");
  });

  it("node=24.22.1 is not affected", async () => {
    const body = await ok(await get("/v1/check?node=24.22.1", "192.0.2.11"));
    expect(body.checked).toBe(1);
    expect(body.affected).toEqual([]);
  });

  it("node=24.22.0&php=8.4.26: php (critical) before node (high)", async () => {
    const body = await ok(await get("/v1/check?node=24.22.0&php=8.4.26", "192.0.2.12"));
    expect(body.affected.map((a) => a.advisory_id)).toEqual([phpId, nodeId]);
    expect(body.affected[0].cve_ids).toEqual(["CVE-2026-109618"]);
    expect(body.affected[0].fixed_in).toBe("8.4.27");
  });

  it("no known runtime answers 400 with the supported runtimes", async () => {
    for (const q of ["", "?ruby=3.3.0"]) {
      const res = await get(`/v1/check${q}`, "192.0.2.13");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { supported_runtimes: string[] };
      expect(body.supported_runtimes).toContain("node");
      expect(body.supported_runtimes).toContain("php");
    }
  });

  it("an unknown key next to a known runtime is listed in skipped", async () => {
    const body = await ok(await get("/v1/check?node=24.22.1&ruby=3.3.0", "192.0.2.14"));
    expect(body.checked).toBe(1);
    expect(body.skipped).toContainEqual({ raw: "ruby", reason: "unknown runtime" });
  });
});

describe("POST /v1/check (JSON body)", () => {
  it("matches the same advisories as the multipart form; a bad item lands in skipped", async () => {
    const body = await ok(
      await postJson("192.0.2.20", {
        dependencies: [
          { ecosystem: "npm", name: "tcs9-vuln-fixture", version: "1.2.3" },
          { ecosystem: "npm", name: "tcs9-safe-fixture", version: "2.0.0" },
          { ecosystem: "npm", name: "" },
        ],
        runtimes: { node: "24.22.0" },
      }),
    );
    expect(body.checked).toBe(3);
    expect(body.affected.map((a) => a.advisory_id).sort()).toEqual([idFor("C9", 2), nodeId].sort());
    expect(body.skipped).toContainEqual({ raw: JSON.stringify({ ecosystem: "npm", name: "" }), reason: "invalid dependency" });
  });

  it("sorts by severity then exploited: critical+exploited, critical, high", async () => {
    const body = await ok(
      await postJson("192.0.2.21", {
        dependencies: [
          { ecosystem: "npm", name: "tcs9-sort-high", version: "1.0.0" },
          { ecosystem: "npm", name: "tcs9-sort-crit", version: "1.0.0" },
          { ecosystem: "npm", name: "tcs9-sort-critx", version: "1.0.0" },
        ],
      }),
    );
    expect(body.affected.map((a) => a.dependency.name)).toEqual(["tcs9-sort-critx", "tcs9-sort-crit", "tcs9-sort-high"]);
  });

  it("450 keys across 3 chunks: the vulnerable one at position 420 is found", async () => {
    const dependencies = Array.from({ length: 450 }, (_, i) => ({
      ecosystem: "npm",
      name: i === 420 ? "tcs9-bulk-420" : `tcs9-bulk-clean-${i}`,
      version: "1.0.0",
    }));
    const body = await ok(await postJson("192.0.2.22", { dependencies }));
    expect(body.checked).toBe(450);
    expect(body.affected.map((a) => a.dependency.name)).toEqual(["tcs9-bulk-420"]);
  });

  it("PyPI: a dependency named Django matches the advisory on django", async () => {
    const body = await ok(
      await postJson("192.0.2.23", { dependencies: [{ ecosystem: "PyPI", name: "Django", version: "4.2.0" }] }),
    );
    expect(body.affected).toHaveLength(1);
    expect(body.affected[0].fixed_in).toBe("5.0.0");
  });

  it("a same-named package in another ecosystem is not matched", async () => {
    const body = await ok(
      await postJson("192.0.2.24", { dependencies: [{ ecosystem: "npm", name: "tcs9-vuln-fixture", version: "1.2.4" }] }),
    );
    expect(body.checked).toBe(1);
    expect(body.affected).toEqual([]);
  });

  it("an unsupported ecosystem is skipped, not counted as checked", async () => {
    const dep = { ecosystem: "Maven", name: "org.example:fixture", version: "1.0.0" };
    const body = await ok(
      await postJson("192.0.2.25", { dependencies: [dep, { ecosystem: "npm", name: "tcs9-safe-fixture", version: "2.0.0" }] }),
    );
    expect(body.checked).toBe(1);
    expect(body.skipped).toContainEqual({ dependency: dep, reason: "unsupported_ecosystem" });
  });

  it("an invalid version is skipped with the advisory ids, never reported clean", async () => {
    const dep = { ecosystem: "npm", name: "tcs9-vuln-fixture", version: "not-a-version" };
    const body = await ok(await postJson("192.0.2.26", { dependencies: [dep] }));
    expect(body.affected).toEqual([]);
    expect(body.skipped).toContainEqual({ dependency: dep, reason: "invalid_version", advisory_ids: [idFor("C9", 2)] });
  });

  it("refuses invalid JSON, a non-object, wrong field types and an empty object with 400", async () => {
    const bodies = ["{nope", "[]", JSON.stringify({ dependencies: {} }), JSON.stringify({ runtimes: [] }), "{}"];
    for (const b of bodies) {
      const res = await post("192.0.2.27", b, "application/json");
      expect(res.status, b).toBe(400);
    }
  });

  it("feed_cursor is the max cursor, and events since it are empty", async () => {
    const body = await ok(await postJson("192.0.2.28", { runtimes: { node: "24.22.1" } }));
    expect(body.feed_cursor).toBe(seededMaxCursor);
    const res = await get(`/v1/events?since=${body.feed_cursor}`, "192.0.2.28");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { events: unknown[] }).events).toEqual([]);
  });

  it("writes nothing: table row counts are the same after a POST", async () => {
    const count = async () => {
      const rows = await env.DB.batch(
        ["advisories", "advisory_sources", "sources", "settings"].map((t) =>
          env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`),
        ),
      );
      return rows.map((r) => (r.results[0] as { n: number }).n);
    };
    const before = await count();
    await ok(await post("192.0.2.29", lockForm()));
    expect(await count()).toEqual(before);
  });
});

describe("rate limit on /v1/check", () => {
  const PINNED = Date.UTC(2026, 9, 22, 2, 0, 10); // 10 s into a minute window
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows 20 checks per minute per IP; feed reads do not use the check budget", async () => {
    const ip = "198.51.100.90";
    for (let i = 0; i < 60; i++) expect((await get("/v1/events?ecosystem=eco-c9", ip)).status).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await get("/v1/check?node=24.22.1", ip)).status);
    expect(statuses.every((s) => s === 200)).toBe(true);

    const refused = await get("/v1/check?node=24.22.1", ip);
    expect(refused.status).toBe(429);
    const retry = Number(refused.headers.get("retry-after"));
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBe(50);
    // POST shares the check budget.
    expect((await postJson(ip, { runtimes: { node: "24.22.1" } })).status).toBe(429);
    // Another IP is not affected.
    expect((await get("/v1/check?node=24.22.1", "198.51.100.91")).status).toBe(200);
  }, 30_000);

  it("reads the limit from the check.anon_rate_per_minute settings row", async () => {
    const set = (v: string) =>
      env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'check.anon_rate_per_minute'").bind(v).run();
    await set("2");
    try {
      const ip = "198.51.100.92";
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await get("/v1/check?node=24.22.1", ip)).status);
      expect(statuses).toEqual([200, 200, 429]);
    } finally {
      await set("20");
    }
  });
});

describe("discovery lists the check endpoint", () => {
  it("well-known has endpoints.check and still validates; llms.txt documents it", async () => {
    const res = await get("/.well-known/tocsin.json", "198.51.100.95");
    const doc = (await res.json()) as { endpoints: Record<string, string> };
    expect(validateWellKnown(doc), JSON.stringify(validateWellKnown.errors)).toBe(true);
    expect(doc.endpoints.check).toBe("https://tocsin.sh/v1/check");

    const text = await (await get("/llms.txt", "198.51.100.95")).text();
    expect(text).toContain("/v1/check");
    expect(text).toContain("feed_cursor");
    expect(text).toContain("package-lock.json=@package-lock.json");
  });
});
