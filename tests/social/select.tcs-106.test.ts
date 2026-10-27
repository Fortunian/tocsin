import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSocialLane } from "../../src/cron/social";
import { readSocialConfig } from "../../src/social/config";
import { qualifies, ulidTime } from "../../src/social/select";
import type { Advisory } from "../../src/schema/advisory";
import { callsFor, postsFor, resetSocial, seedAdvisory, setKnob, updateAdvisory } from "./helpers.tcs-106";

// TCS-106 selection rule: a runtime advisory at or above social.x.min_severity
// qualifies once, on first sight, and never on a later update.

const HOUR = 3_600_000;
const tick = () => runSocialLane(env, new Date());

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetSocial();
});
afterEach(() => vi.restoreAllMocks());

describe("selection through the lane", () => {
  it("S1: a critical node-runtime advisory created after the watermark posts once; a second tick writes no second row", async () => {
    const a = await seedAdvisory({ severity: "critical" });
    await tick();
    const rows = await postsFor(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ok");
    await tick();
    expect(await postsFor(a.id)).toHaveLength(1);
    expect(await callsFor(a.id)).toHaveLength(1);
  });

  it("S2: a medium advisory never qualifies, and raising it to critical later (same id, new cursor) still writes no row", async () => {
    const a = await seedAdvisory({ severity: "medium" });
    await tick();
    expect(await postsFor(a.id)).toHaveLength(0);
    const before = a.cursor;
    const after = await updateAdvisory(a, { severity: { label: "critical" } });
    expect(after).toBeGreaterThan(before);
    await tick();
    expect(await postsFor(a.id)).toHaveLength(0);
    expect(await callsFor(a.id)).toHaveLength(0);
  });

  it("S3: an advisory whose doc carries withdrawn never qualifies", async () => {
    // The schema has no withdrawn field, so no ingester stores one today; the
    // selector refuses it anyway (plan ASSUMPTIONS 1). The doc is edited in place.
    const a = await seedAdvisory({ severity: "critical" });
    await env.DB.prepare("UPDATE advisories SET doc_json = json_set(doc_json, '$.withdrawn', '2026-10-27T00:00:00Z') WHERE id = ?").bind(a.id).run();
    await tick();
    expect(await postsFor(a.id)).toHaveLength(0);
    expect(await callsFor(a.id)).toHaveLength(0);
  });

  it("S4: an update to an advisory that already has an ok row writes nothing and makes no call", async () => {
    const a = await seedAdvisory({ severity: "critical" });
    await tick();
    const [first] = await postsFor(a.id);
    expect(first.status).toBe("ok");
    await updateAdvisory(a, { summary: `${a.input.summary} (edited)` });
    await tick();
    const rows = await postsFor(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].updated_at).toBe(first.updated_at);
    expect(rows[0].text).toBe(first.text);
    expect(await callsFor(a.id)).toHaveLength(1);
  });

  it("S5: near misses: npm and Go module rows never post; a Go stdlib row from OSV posts; an old one never", async () => {
    const npm = await seedAdvisory({ ecosystem: "npm", component: "left-pad-fixture", source: "osv" });
    const goMod = await seedAdvisory({ ecosystem: "Go", component: "golang.org/x/net", source: "osv", fixed: ["0.38.0"] });
    const goStd = await seedAdvisory({ ecosystem: "Go", component: "stdlib", source: "osv", fixed: ["1.24.9", "1.25.3"] });
    const old = await seedAdvisory({ publishedAt: new Date(Date.now() - 100 * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z") });
    await tick();
    expect(await postsFor(npm.id)).toHaveLength(0);
    expect(await postsFor(goMod.id)).toHaveLength(0);
    expect((await postsFor(goStd.id)).map((r) => r.status)).toEqual(["ok"]);
    expect(await postsFor(old.id)).toHaveLength(0);
    expect(await callsFor(goStd.id)).toHaveLength(1);
  });

  it("S6: min_severity=high lets a high one post; an unknown min_severity acts as critical", async () => {
    await setKnob("social.x.min_severity", "high");
    const high = await seedAdvisory({ severity: "high" });
    await tick();
    expect((await postsFor(high.id)).map((r) => r.status)).toEqual(["ok"]);

    await setKnob("social.x.min_severity", "severe-ish");
    const high2 = await seedAdvisory({ severity: "high" });
    const crit = await seedAdvisory({ severity: "critical" });
    await tick();
    expect(await postsFor(high2.id)).toHaveLength(0);
    expect(await postsFor(crit.id)).toHaveLength(1);
  });

  it("S7: a source not listed in social.x.sources never posts", async () => {
    await setKnob("social.x.sources", "php-runtime");
    const node = await seedAdvisory({ severity: "critical" });
    const php = await seedAdvisory({ ecosystem: "php", source: "php-runtime", fixed: ["8.4.27"] });
    await tick();
    expect(await postsFor(node.id)).toHaveLength(0);
    expect(await postsFor(php.id)).toHaveLength(1);
  });
});

describe("qualifies (pure)", () => {
  const now = new Date("2026-10-27T12:00:00Z");
  const prev = "2026-10-27T11:50:00.000Z";
  // 2026-10-27T11:55:00Z as a ULID time part.
  function idAt(ms: number): string {
    const C = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let t = ms;
    let s = "";
    for (let i = 0; i < 10; i++) {
      s = C[t % 32] + s;
      t = Math.floor(t / 32);
    }
    return `tcs_${s}0000000000000000`;
  }
  const base = (over: Partial<Advisory> = {}): Advisory => ({
    id: idAt(Date.parse("2026-10-27T11:55:00Z")),
    cve_ids: [],
    ecosystem: "node",
    component: "node",
    affected: [],
    fixed_versions: ["24.22.1"],
    severity: { label: "critical" },
    exploited: false,
    published_at: "2026-10-27T11:00:00Z",
    modified_at: "2026-10-27T11:00:00Z",
    summary: "s",
    action: "a",
    references: [],
    sources: [{ source: "node-runtime", source_id: "x", url: "https://example.test/x" }],
    ...over,
  });

  it("Q1: ulidTime decodes the time part of an advisory id", () => {
    expect(ulidTime(idAt(1_793_000_000_123))).toBe(1_793_000_000_123);
    expect(ulidTime("not-an-id")).toBeNull();
  });

  it("Q2: first sight is the id time against the previous scan time", async () => {
    const cfg = await readSocialConfig(env.DB);
    expect(qualifies(base(), cfg, prev, now)).toBe(true);
    expect(qualifies(base({ id: idAt(Date.parse("2026-10-27T11:40:00Z")) }), cfg, prev, now)).toBe(false);
    expect(qualifies(base({ severity: { label: "high" } }), cfg, prev, now)).toBe(false);
    expect(qualifies(base({ sources: [{ source: "osv", source_id: "y", url: "https://example.test/y" }] }), cfg, prev, now)).toBe(false);
  });
});
