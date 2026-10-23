// `tocsin check`: send the lockfiles in cwd and the installed runtime versions
// to POST /v1/check. Exit 1 when anything is affected, 0 when clean, 2 when
// there is nothing to check, 3 when the check could not run or when a checked
// ecosystem has partial coverage and nothing is affected.
import { Api, describeFailure, type ApiResult } from "./api.js";
import type { Io } from "./io.js";
import { LOCKFILE_NAMES, findLockfiles, isLockfileName } from "./lockfiles.js";

// The lockfile list lives in lockfiles.js, shared with the GitHub Action.
export { isLockfileName };
export const LOCKFILE_NAMES_FOR_TEST: readonly string[] = [...LOCKFILE_NAMES];

const PROBE_TIMEOUT_MS = 5_000;
const PROBES: [runtime: string, ...commands: [string, string[]][]][] = [
  ["node", ["node", ["--version"]]],
  ["php", ["php", ["--version"]]],
  ["python", ["python", ["--version"]], ["python3", ["--version"]]],
  ["go", ["go", ["version"]]],
  ["bun", ["bun", ["--version"]]],
  ["deno", ["deno", ["--version"]]],
];

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

interface AffectedItem {
  dependency?: { name?: string; version?: string };
  advisory_id?: string;
  severity?: { label?: string };
  exploited?: boolean;
  fixed_in?: string | null;
  action?: string;
}

interface Coverage {
  ecosystem: string;
  since: string | null;
  complete: boolean;
}

interface CheckResult {
  checked: number;
  affected: AffectedItem[];
  skipped: unknown[];
  feed_cursor: number;
  // Absent from a server before TCS-32.
  coverage?: Coverage[];
}

async function probe(io: Io, commands: [string, string[]][]): Promise<string | null> {
  for (const [cmd, args] of commands) {
    let r;
    try {
      r = await io.exec(cmd, args, PROBE_TIMEOUT_MS);
    } catch {
      continue;
    }
    if (r.code !== 0) continue;
    const m = /\d+\.\d+(?:\.\d+)?/.exec(`${r.stdout}\n${r.stderr}`);
    if (m) return m[0];
  }
  return null;
}

/** Runtime versions found on this machine. A missing or broken runtime is left out. */
export async function detectRuntimes(io: Io): Promise<Record<string, string>> {
  const found = await Promise.all(PROBES.map(async ([rt, ...commands]) => [rt, await probe(io, commands)] as const));
  const out: Record<string, string> = {};
  for (const [rt, v] of found) if (v !== null) out[rt] = v;
  return out;
}

function isCheckResult(b: unknown): b is CheckResult {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return typeof o.checked === "number" && Array.isArray(o.affected) && Array.isArray(o.skipped) && typeof o.feed_cursor === "number";
}

const cmp = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);
const byEcosystem = (a: string, b: string) => cmp(a.toLowerCase(), b.toLowerCase()) || cmp(a, b);

function isCoverage(c: unknown): c is Coverage {
  const o = c as Partial<Coverage> | null;
  return typeof o?.ecosystem === "string" && typeof o.complete === "boolean" && (o.since === null || typeof o.since === "string");
}

// One entry per ecosystem: partial if any part says partial; since is the earliest known.
function mergeCoverage(parts: CheckResult[]): Coverage[] | undefined {
  const lists = parts.map((p) => p.coverage).filter((c): c is Coverage[] => Array.isArray(c));
  if (lists.length === 0) return undefined;
  const out = new Map<string, Coverage>();
  for (const c of lists.flat().filter(isCoverage)) {
    const prev = out.get(c.ecosystem);
    if (!prev) {
      out.set(c.ecosystem, { ...c });
      continue;
    }
    prev.complete = prev.complete && c.complete;
    if (c.since !== null && (prev.since === null || c.since < prev.since)) prev.since = c.since;
  }
  return [...out.values()].sort((a, b) => byEcosystem(a.ecosystem, b.ecosystem));
}

function merge(parts: CheckResult[]): CheckResult {
  const affected = parts.flatMap((p) => p.affected);
  // The server's order: severity, then exploited, then advisory id.
  affected.sort(
    (x, y) =>
      (SEVERITY_RANK[y.severity?.label ?? ""] ?? 0) - (SEVERITY_RANK[x.severity?.label ?? ""] ?? 0) ||
      Number(Boolean(y.exploited)) - Number(Boolean(x.exploited)) ||
      cmp(x.advisory_id, y.advisory_id),
  );
  const coverage = mergeCoverage(parts);
  return {
    checked: parts.reduce((n, p) => n + p.checked, 0),
    affected,
    skipped: parts.flatMap((p) => p.skipped),
    // The lower cursor, so a follow-up feed read skips no advisory.
    feed_cursor: Math.min(...parts.map((p) => p.feed_cursor)),
    ...(coverage ? { coverage } : {}),
  };
}

// "Coverage: node partial (since unknown), npm since 2016-01-05, PyPI partial (since 2026-10-15)".
function coverageLine(coverage: Coverage[]): string {
  const day = (s: string) => s.slice(0, 10);
  const parts = coverage.map((c) => {
    if (c.complete) return c.since === null ? `${c.ecosystem} complete` : `${c.ecosystem} since ${day(c.since)}`;
    return `${c.ecosystem} partial (since ${c.since === null ? "unknown" : day(c.since)})`;
  });
  return `Coverage: ${parts.join(", ")}`;
}

const isPartial = (data: CheckResult) => (data.coverage ?? []).some((c) => !c.complete);

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd());
}

function print(io: Io, data: CheckResult): void {
  const skipped = data.skipped.length > 0 ? ` ${data.skipped.length} skipped (not checked).` : "";
  const coverage = data.coverage && data.coverage.length > 0 ? coverageLine(data.coverage) : undefined;
  if (data.affected.length === 0) {
    // Partial coverage is not a clean result: say what was not checked.
    if (isPartial(data)) io.out(`0 of ${data.checked} dependencies affected. Coverage is partial, so this is not a clean result.${skipped}`);
    else io.out(`No known advisory affects the ${data.checked} checked dependencies.${skipped}`);
    if (coverage) io.out(coverage);
    return;
  }
  const rows = [["SEVERITY", "PACKAGE@VERSION", "ADVISORY", "FIXED IN", "ACTION"]];
  for (const a of data.affected) {
    const sev = (a.severity?.label ?? "unknown") + (a.exploited ? ", exploited" : "");
    rows.push([sev, `${a.dependency?.name ?? "?"}@${a.dependency?.version ?? "?"}`, a.advisory_id ?? "?", a.fixed_in ?? "-", (a.action ?? "").replace(/\s+/g, " ")]);
  }
  for (const line of table(rows)) io.out(line);
  io.out("");
  io.out(`${data.affected.length} of ${data.checked} dependencies affected.${skipped}`);
  if (coverage) io.out(coverage);
}

/** The check itself: the exit code, and the merged result when the API answered. Errors go to io.err. */
async function checkResult(io: Io): Promise<{ code: 0 | 1 | 2 | 3; data?: CheckResult }> {
  const [lockfiles, runtimes] = await Promise.all([findLockfiles(io.cwd), detectRuntimes(io)]);
  const hasRuntimes = Object.keys(runtimes).length > 0;
  if (lockfiles.length === 0 && !hasRuntimes) {
    io.err(`tocsin check: no lockfile in ${io.cwd} and no runtime found; run in a project directory`);
    return { code: 2 };
  }

  const api = new Api(io);
  const calls: Promise<ApiResult>[] = [];
  if (lockfiles.length > 0) calls.push(api.checkLockfiles(lockfiles));
  if (hasRuntimes) calls.push(api.checkRuntimes(runtimes));
  const answers = await Promise.all(calls);

  const parts: CheckResult[] = [];
  for (const r of answers) {
    // A failed or malformed answer is never a clean result.
    if (!r.ok || !isCheckResult(r.body)) {
      io.err(`check failed: ${describeFailure(r)}`);
      return { code: 3 };
    }
    parts.push(r.body);
  }
  const data = merge(parts);
  // Affected wins over partial: it is the answer to act on first. Partial coverage is exit 3, never clean.
  return { code: data.affected.length > 0 ? 1 : isPartial(data) ? 3 : 0, data };
}

/**
 * `check --summary`: one line for the Claude Code SessionStart hook. Always
 * returns 0 so the hook never blocks a session; the line carries the real code.
 */
async function runSummary(io: Io): Promise<number> {
  let r: Awaited<ReturnType<typeof checkResult>>;
  try {
    r = await checkResult({ ...io, err: () => undefined });
  } catch (e) {
    io.out(`tocsin: check failed (${e instanceof Error ? e.message : String(e)})`);
    return 0;
  }
  if (r.code === 2) io.out("tocsin: nothing to check here (exit 2)");
  else if (!r.data) io.out("tocsin: check failed (network)");
  else if (r.code === 3) io.out(`tocsin: 0 affected of ${r.data.checked} checked, but coverage is partial (exit 3). Run npx tocsin check for details.`);
  else {
    const d = r.data;
    const skipped = d.skipped.length > 0 ? `, ${d.skipped.length} skipped` : "";
    if (r.code === 0) io.out(`tocsin: 0 affected of ${d.checked} checked${skipped} (exit 0)`);
    else {
      const exploited = d.affected.filter((a) => a.exploited).length;
      io.out(`tocsin: ${d.affected.length} affected of ${d.checked} checked, ${exploited} exploited${skipped} (exit 1). Run npx tocsin check --json for details.`);
    }
  }
  return 0;
}

export async function runCheck(io: Io, values: Record<string, unknown>): Promise<number> {
  if (values.summary) return runSummary(io);
  const { code, data } = await checkResult(io);
  if (data) {
    if (values.json) io.out(JSON.stringify(data));
    else print(io, data);
  }
  return code;
}
