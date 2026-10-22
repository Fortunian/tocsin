// CVSS v3.0 / v3.1 base score from a vector string, per the FIRST
// specification. CVSS v4 and malformed vectors return undefined.
import type { SeverityLabel } from "../schema/advisory";

const WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  S: { U: 0, C: 1 },
  C: { H: 0.56, L: 0.22, N: 0 },
  I: { H: 0.56, L: 0.22, N: 0 },
  A: { H: 0.56, L: 0.22, N: 0 },
} as const;
const PR_UNCHANGED = { N: 0.85, L: 0.62, H: 0.27 } as const;
const PR_CHANGED = { N: 0.85, L: 0.68, H: 0.5 } as const;
const BASE_METRICS = ["AV", "AC", "PR", "UI", "S", "C", "I", "A"] as const;

// v3.1 Roundup (spec Appendix A): avoids floating point error.
function roundup31(x: number): number {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
}

function roundup30(x: number): number {
  return Math.ceil(x * 10) / 10;
}

export function cvss3BaseScore(vector: string): number | undefined {
  const m = /^CVSS:3\.([01])\/(.+)$/.exec(vector.trim());
  if (!m) return undefined;
  const roundup = m[1] === "1" ? roundup31 : roundup30;
  const metrics = new Map<string, string>();
  for (const part of m[2].split("/")) {
    const kv = /^([A-Z]+):([A-Z])$/.exec(part);
    if (!kv || metrics.has(kv[1])) return undefined;
    metrics.set(kv[1], kv[2]);
  }
  const v: Record<string, number> = {};
  for (const key of BASE_METRICS) {
    const value = metrics.get(key);
    if (value === undefined) return undefined;
    const table: Record<string, number> = key === "PR" ? PR_UNCHANGED : WEIGHTS[key];
    if (!(value in table)) return undefined;
    v[key] = table[value];
  }
  const changed = metrics.get("S") === "C";
  const pr = (changed ? PR_CHANGED : PR_UNCHANGED)[metrics.get("PR") as keyof typeof PR_UNCHANGED];
  const iss = 1 - (1 - v.C) * (1 - v.I) * (1 - v.A);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  const exploitability = 8.22 * v.AV * v.AC * pr * v.UI;
  if (impact <= 0) return 0;
  return changed ? roundup(Math.min(1.08 * (impact + exploitability), 10)) : roundup(Math.min(impact + exploitability, 10));
}

// CVSS qualitative severity bands (spec section 5). A score of 0 is "None"
// in CVSS; the advisory schema has no "none", so it maps to unknown.
export function labelFromScore(score: number): SeverityLabel {
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0) return "low";
  return "unknown";
}
