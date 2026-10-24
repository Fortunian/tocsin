// The four MCP tools as pure handlers over the TocsinApi seam. Every `human`
// line is a template over the API's answer: deterministic, no LLM.
import { z } from "zod";
import type { ApiResult, TocsinApi } from "./api";

export interface ToolResult {
  human: string;
  data: unknown;
  isError: boolean;
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
// The same shape the API route accepts at /v1/events/cve/:cve.
const CVE_RE = /^CVE-\d{4}-\d{4,}$/i;

export const latestInput = {
  ecosystem: z.string().min(1).optional().describe("OSV ecosystem or runtime name, for example node, npm, PyPI"),
  min_severity: z.enum(SEVERITIES).optional(),
  exploited_only: z.boolean().optional().describe("Only advisories known to be exploited"),
  // 100 is the API's own page cap; the API stays the authority.
  limit: z.number().int().min(1).max(100).optional().describe("1..100, default 10"),
};
export const checkInput = {
  lockfile_name: z.string().min(1).optional().describe("package-lock.json, pnpm-lock.yaml, yarn.lock, requirements.txt, go.sum, composer.lock, Cargo.lock, Gemfile.lock, pom.xml, gradle.lockfile, packages.lock.json, mix.lock, pubspec.lock"),
  lockfile_text: z.string().min(1).optional().describe("The full lockfile text"),
  runtimes: z.record(z.string(), z.string()).optional().describe('Runtime versions, for example {"node":"24.22.0"}'),
};
export const getInput = {
  id_or_cve: z.string().min(1).describe("A Tocsin advisory id or a CVE id"),
};
export const watchlistInput = {
  watchlist_id: z.string().min(1),
};

type Args<T extends z.ZodRawShape> = z.infer<z.ZodObject<T>>;
export type LatestArgs = Args<typeof latestInput>;
export type CheckArgs = Args<typeof checkInput>;
export type GetArgs = Args<typeof getInput>;
export type WatchlistArgs = Args<typeof watchlistInput>;

interface Event {
  id: string;
  cve_ids?: string[];
  component?: string;
  severity?: { label?: string };
  exploited?: boolean;
  action?: string;
}
interface Page {
  events: Event[];
}
interface AffectedItem {
  dependency?: { name?: string; version?: string };
  severity?: { label?: string };
  exploited?: boolean;
  action?: string;
}
interface CheckResult {
  checked: number;
  affected: AffectedItem[];
  skipped: unknown[];
  feed_cursor: number;
}

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").trim();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function ok(human: string, data: unknown): ToolResult {
  return { human: oneLine(human), data, isError: false };
}

function fail(human: string, data: unknown): ToolResult {
  return { human: oneLine(human), data, isError: true };
}

// A non-2xx is never an empty success.
function apiError(r: ApiResult): ToolResult {
  const message = isObject(r.body) && typeof r.body.error === "string" ? r.body.error : String(r.body ?? "");
  if (r.status === 0) return fail(`Tocsin API did not answer: ${message}`, r.body);
  const retry = r.status === 429 && r.retryAfter ? ` Retry after ${r.retryAfter} s.` : "";
  return fail(`Tocsin API answered ${r.status}: ${message}.${retry}`, r.body);
}

function unexpected(r: ApiResult): ToolResult {
  return fail(`Tocsin API answered ${r.status} with an unexpected body.`, r.body);
}

function isPage(body: unknown): body is Page {
  return isObject(body) && Array.isArray(body.events);
}

function isCheckResult(body: unknown): body is CheckResult {
  return (
    isObject(body) &&
    typeof body.checked === "number" &&
    Array.isArray(body.affected) &&
    Array.isArray(body.skipped) &&
    typeof body.feed_cursor === "number"
  );
}

function describeEvent(e: Event): string {
  const parts = [e.id, e.component, e.severity?.label].filter((p) => p);
  return `${parts.join(" ")}${e.exploited ? ", exploited" : ""}`;
}

export async function latest(api: TocsinApi, args: LatestArgs): Promise<ToolResult> {
  const params: Record<string, string> = { order: "desc", limit: String(args.limit ?? 10) };
  if (args.ecosystem) params.ecosystem = args.ecosystem;
  if (args.min_severity) params.min_severity = args.min_severity;
  if (args.exploited_only) params.exploited = "true";
  const r = await api.events(params);
  if (!r.ok) return apiError(r);
  if (!isPage(r.body)) return unexpected(r);
  const events = r.body.events;
  if (events.length === 0) return ok("No advisories match these filters.", r.body);
  return ok(`${plural(events.length, "advisory", "advisories")}, newest first. Newest: ${describeEvent(events[0])}.`, r.body);
}

function worst(items: AffectedItem[]): AffectedItem {
  let best = items[0];
  const score = (a: AffectedItem) => (SEVERITY_RANK[a.severity?.label ?? ""] ?? 0) * 2 + (a.exploited ? 1 : 0);
  for (const item of items) if (score(item) > score(best)) best = item;
  return best;
}

export async function check(api: TocsinApi, args: CheckArgs): Promise<ToolResult> {
  const hasRuntimes = args.runtimes !== undefined && Object.keys(args.runtimes).length > 0;
  const hasLockfile = args.lockfile_name !== undefined || args.lockfile_text !== undefined;
  if (hasLockfile && (!args.lockfile_name || !args.lockfile_text)) {
    return fail("Send lockfile_name and lockfile_text together; the API reads the file type from its name.", { error: "lockfile_name and lockfile_text go together" });
  }
  if (!hasLockfile && !hasRuntimes) {
    return fail('Nothing to check. Send lockfile_name + lockfile_text, or runtimes like {"node":"24.22.0"}.', { error: "nothing to check" });
  }

  // The API takes lockfiles only as multipart and runtimes only as JSON or a
  // query, so a call with both runs two checks in parallel and merges them.
  const calls: Promise<ApiResult>[] = [];
  if (hasLockfile) calls.push(api.checkLockfile(args.lockfile_name!, args.lockfile_text!));
  if (hasRuntimes) calls.push(api.checkRuntimes(args.runtimes!));
  const answers = await Promise.all(calls);

  const parts: CheckResult[] = [];
  for (const r of answers) {
    if (!r.ok) return apiError(r);
    if (!isCheckResult(r.body)) return unexpected(r);
    parts.push(r.body);
  }
  const data: CheckResult = {
    checked: parts.reduce((n, p) => n + p.checked, 0),
    affected: parts.flatMap((p) => p.affected),
    skipped: parts.flatMap((p) => p.skipped),
    // The lower cursor, so a follow-up feed read skips no advisory.
    feed_cursor: Math.min(...parts.map((p) => p.feed_cursor)),
  };

  // skipped is never a clean result: say so in every state.
  const skipped = data.skipped.length ? ` ${data.skipped.length} skipped.` : "";
  if (data.affected.length === 0) {
    return ok(`No known advisory affects the ${data.checked} checked dependencies.${skipped}`, data);
  }
  const w = worst(data.affected);
  const dep = [w.dependency?.name, w.dependency?.version].filter((p) => p).join(" ");
  return ok(`${data.affected.length} of ${data.checked} dependencies affected. Worst: ${dep}: ${w.action ?? ""}${skipped}`, data);
}

export async function get(api: TocsinApi, args: GetArgs): Promise<ToolResult> {
  const input = args.id_or_cve.trim();
  const r = CVE_RE.test(input) ? await api.getByCve(input.toUpperCase()) : await api.get(input);
  if (r.status === 404) return fail(`No advisory found for ${input}.`, r.body);
  if (!r.ok) return apiError(r);
  if (!isObject(r.body) || typeof r.body.id !== "string") return unexpected(r);
  const e = r.body as unknown as Event;
  const cves = e.cve_ids?.length ? ` (${e.cve_ids.join(", ")})` : "";
  const head = [`${e.id}${cves}`, e.component, e.severity?.label].filter((p) => p).join(" ");
  return ok(`${head}${e.exploited ? ", exploited" : ""}: ${e.action ?? ""}`, r.body);
}

export async function watchlistEvents(api: TocsinApi, args: WatchlistArgs, bearer: string | null): Promise<ToolResult> {
  if (!bearer) {
    return fail("This tool needs an API key. Send Authorization: Bearer tcs_... on the MCP connection.", { error: "no API key on the MCP connection" });
  }
  const r = await api.watchlistEvents(args.watchlist_id, bearer);
  if (!r.ok) return apiError(r);
  if (!isPage(r.body)) return unexpected(r);
  const events = r.body.events;
  if (events.length === 0) return ok(`No new events on watch list ${args.watchlist_id}.`, r.body);
  // The watch list answers from its stored cursor, oldest first, like the feed.
  const newest = events[events.length - 1];
  return ok(`${plural(events.length, "new event", "new events")} on watch list ${args.watchlist_id}. Newest: ${describeEvent(newest)}.`, r.body);
}

// The MCP wire form: the same {human, data} as text and as structuredContent.
export function toCallToolResult(r: ToolResult) {
  const payload = { human: r.human, data: r.data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: r.isError,
  };
}
