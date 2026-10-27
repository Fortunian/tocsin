// The post text of the social lane (TCS-106). Pure and deterministic: every
// value comes from the stored advisory; no LLM.
//   <Runtime> <lines>: <summary>. Severity <label>, fixed in <fixed list>. <URL>
import { advisoryPath, SITE_BASE } from "../../site/advisory";
import type { Advisory } from "../schema/advisory";

export interface TextOptions {
  maxChars: number; // social.x.max_chars
  urlChars: number; // social.x.url_chars
  minSummaryChars: number; // social.x.min_summary_chars
}

const RUNTIME_NAME: Record<string, string> = { node: "Node.js", php: "PHP", python: "Python", deno: "Deno", bun: "Bun", Go: "Go" };
// Release lines are a major for these runtimes, a major.minor for the rest.
const MAJOR_LINES = new Set(["node", "deno", "bun"]);

const ELLIPSIS = "…";
const URL_RE = /https?:\/\/\S+/g;

// X's weighted length: code points in these ranges weigh 1, all others 2;
// every URL weighs urlChars whatever its length.
const LIGHT: [number, number][] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];
function weightOf(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return n;
}

export function weightedLength(text: string, urlChars: number): number {
  const urls = text.match(URL_RE) ?? [];
  return weightOf(text.replace(URL_RE, "")) + urls.length * urlChars;
}

function parts(v: string): number[] {
  return v.split(".").map((p) => {
    const m = /^\d+/.exec(p);
    return m ? Number(m[0]) : 0;
  });
}

export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

function lineOf(ecosystem: string, version: string): string {
  const p = version.replace(/^v/, "").split(".");
  return MAJOR_LINES.has(ecosystem) ? `${p[0]}.x` : `${p[0]}.${p[1] ?? "0"}.x`;
}

function collapse(items: string[], n: number): string {
  return items.length > n ? `${items.slice(0, n).join(", ")} +${items.length - n} more` : items.join(", ");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
}

function cut(s: string, budget: number): string {
  const chars = [...s];
  if (weightOf(s) <= budget) return s;
  const room = budget - weightOf(ELLIPSIS);
  let out = "";
  let w = 0;
  for (const ch of chars) {
    const cw = weightOf(ch);
    if (w + cw > room) break;
    out += ch;
    w += cw;
  }
  return `${out.trimEnd()}${ELLIPSIS}`;
}

/**
 * The post text, at most opts.maxChars after X's weighting. Over budget, the
 * summary is cut with … down to opts.minSummaryChars; if that is not enough,
 * the release lines and fixed list are shortened to their first n items plus
 * "+k more". The URL is never cut.
 */
export function renderPostText(doc: Advisory, opts: TextOptions): string {
  const name = RUNTIME_NAME[doc.ecosystem] ?? doc.ecosystem;
  const url = `${SITE_BASE}${advisoryPath(doc.id)}`;
  const fixed = [...new Set(doc.fixed_versions)].sort(compareVersions);
  const lineSource = fixed.length > 0 ? fixed : doc.affected.map((r) => r.introduced).filter((v): v is string => v !== undefined && v !== "0");
  const lines = [...new Set([...lineSource].sort(compareVersions).map((v) => lineOf(doc.ecosystem, v)))];
  const summary = oneLine(doc.summary);

  const build = (n: number, s: string) => {
    const head = lines.length > 0 ? `${name} ${collapse(lines, n)}` : name;
    const fix = fixed.length > 0 ? `fixed in ${collapse(fixed, n)}` : "no fixed version yet";
    return `${head}: ${s}. Severity ${doc.severity.label}, ${fix}. ${url}`;
  };

  const full = build(Math.max(lines.length, fixed.length), summary);
  if (weightedLength(full, opts.urlChars) <= opts.maxChars) return full;

  for (let n = Math.max(lines.length, fixed.length); n >= 1; n--) {
    const budget = opts.maxChars - weightedLength(build(n, ""), opts.urlChars);
    if (budget >= Math.min(opts.minSummaryChars, weightOf(summary)) || n === 1) {
      return build(n, cut(summary, Math.max(budget, weightOf(ELLIPSIS))));
    }
  }
  return build(1, cut(summary, weightOf(ELLIPSIS)));
}
