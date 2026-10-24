// Shared checks for the TCS-38 per-ecosystem tests: a comparator order table,
// and real OSV records matched through normalizeOsv and matchAdvisory, the
// same path the import route and /v1/check use.
import { expect } from "vitest";
import { matchAdvisory } from "../../src/check/match";
import type { Comparator } from "../../src/check/match/types";
import { normalizeOsv, type OsvVuln } from "../../src/ingest/osv";
import type { Advisory } from "../../src/schema/advisory";

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** Each group holds equal versions; the groups are in strictly ascending order. Every pair is checked both ways. */
export function expectAscending(cmp: Comparator, groups: (string | string[])[]): void {
  const gs = groups.map((g) => (Array.isArray(g) ? g : [g]));
  const all = gs.flatMap((g, gi) => g.map((v) => ({ v, gi })));
  for (const { v } of all) expect(cmp.valid(v), `valid(${JSON.stringify(v)})`).toBe(true);
  for (const a of all) {
    for (const b of all) {
      const want = sign(a.gi - b.gi);
      expect(sign(cmp.compare(a.v, b.v)), `compare(${a.v}, ${b.v})`).toBe(want);
    }
  }
}

export function expectInvalid(cmp: Comparator, versions: string[]): void {
  for (const v of versions) {
    expect(cmp.valid(v), `valid(${JSON.stringify(v)})`).toBe(false);
    expect(() => cmp.compare(v, "1"), `compare(${JSON.stringify(v)}, "1") throws`).toThrow();
  }
}

/** One real OSV record: a version inside its range and one outside, for the dependency ecosystem `dep`. */
export interface RecordCase {
  id: string;
  dep: string;
  name: string;
  affected: string;
  notAffected: string;
  fixed_in?: string | null;
}

/** The normalized docs of a record, as stored advisories (an id added). */
export function advisoriesOf(record: OsvVuln, ecosystems: string[]): Advisory[] {
  const r = normalizeOsv(record, ecosystems);
  expect(r.ok, r.ok ? "" : `${record.id}: ${r.reason}`).toBe(true);
  if (!r.ok) return [];
  return r.docs.map((d, i) => ({ ...d.doc, id: `tcs_TCS38${String(i).padStart(18, "0")}` }) as Advisory);
}

/**
 * For each case: the affected version matches exactly one doc of the record
 * (with its fixed_in), and the not-affected version matches no doc and is not
 * skipped. Every doc of the record is tried, so a doc of another release or
 * package that matches is a failure.
 */
export function expectRecordCases(records: OsvVuln[], ecosystems: string[], cases: RecordCase[]): void {
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const c of cases) {
    const record = byId.get(c.id);
    expect(record, `fixture ${c.id}`).toBeDefined();
    const docs = advisoriesOf(record!, ecosystems);
    const hit = docs.map((a) => matchAdvisory({ ecosystem: c.dep, name: c.name, version: c.affected }, a));
    const hits = hit.filter((m) => m.affected);
    expect(hits.length, `${c.id} ${c.dep} ${c.name}@${c.affected} affected`).toBe(1);
    if (c.fixed_in !== undefined) expect(hits[0].fixed_in ?? null, `${c.id} fixed_in`).toBe(c.fixed_in);
    for (const a of docs) {
      const miss = matchAdvisory({ ecosystem: c.dep, name: c.name, version: c.notAffected }, a);
      expect(miss, `${c.id} ${c.dep} ${c.name}@${c.notAffected} not affected`).toEqual({ affected: false });
    }
  }
}
