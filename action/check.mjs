// The Tocsin GitHub Action: send the checkout's lockfiles to POST /v1/check,
// write a job summary, set the `affected` output, and on a pull request post
// or update one comment (found by MARKER). Plain JavaScript with JSDoc types:
// the runner's `node` runs it straight from the action checkout, with no build
// and no npm install. The lockfile list is the CLI's (packages/cli/src/lockfiles.js).
//
// Exit codes: 1 when an advisory at or above min-severity matches fail-on, or
// on an invalid input; 0 when clean; 0 with a warning when the check could not
// run (network or API error, no lockfile), 1 then when fail-on-error is true.
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LOCKFILE_NAMES, findLockfiles, isLockfileName } from "../packages/cli/src/lockfiles.js";

export { LOCKFILE_NAMES, findLockfiles, isLockfileName };

export const VERSION = "1.0.0";
export const MARKER = "<!-- tocsin-check -->";
export const DEFAULT_BASE_URL = "https://tocsin.sh";
const SEVERITY_RANK = /** @type {Record<string, number>} */ ({ critical: 4, high: 3, medium: 2, low: 1 });
const FAIL_ON = ["affected", "exploited", "never"];
const COMMENT_PAGES = 20;

/**
 * @typedef {{ env: Record<string, string | undefined>; fetch: (url: string, init?: RequestInit) => Promise<Response>; out: (line: string) => void }} Io
 * @typedef {{ ecosystem?: string; name?: string; version?: string }} Dependency
 * @typedef {{ dependency?: Dependency; advisory_id?: string; severity?: { label?: string }; exploited?: boolean; fixed_in?: string | null; action?: string; url?: string }} Affected
 * @typedef {{ dependency?: Dependency; file?: string; raw?: string; reason?: string; advisory_ids?: string[] }} Skipped
 * @typedef {{ checked: number; affected: Affected[]; skipped: Skipped[]; feed_cursor: number }} CheckResult
 * @typedef {{ baseUrl: string; apiKey: string; minSeverity: string; failOn: string; failOnError: boolean; comment: boolean; dir: string; token: string }} Inputs
 */

const UPGRADE = /** @type {Record<string, (name: string, v: string) => string>} */ ({
  npm: (n, v) => `npm i ${n}@${v}`,
  PyPI: (n, v) => `pip install ${n}==${v}`,
  Go: (n, v) => `go get ${n}@${v.startsWith("v") ? v : `v${v}`}`,
  Packagist: (n, v) => `composer require ${n}:${v}`,
  "crates.io": (n) => `cargo update -p ${n}`,
  RubyGems: (n) => `bundle update ${n}`,
});

/**
 * The upgrade command for one dependency, or null when there is no fixed version or no known tool.
 * @param {string} ecosystem @param {string} name @param {string | null | undefined} fixed
 * @returns {string | null}
 */
export function upgradeCommand(ecosystem, name, fixed) {
  const f = Object.hasOwn(UPGRADE, ecosystem) ? UPGRADE[ecosystem] : undefined;
  return f && fixed ? f(name, fixed) : null;
}

// ---- inputs -------------------------------------------------------------

/** @param {string | undefined} v @param {boolean} def */
function bool(v, def) {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "") return def;
  if (s === "true" || s === "false") return s === "true";
  throw new Error(`expected true or false, got "${v}"`);
}

/**
 * Reads and validates the inputs. Throws with a message naming the bad input.
 * @param {Record<string, string | undefined>} env
 * @returns {Inputs}
 */
export function readInputs(env) {
  const minSeverity = (env.TOCSIN_MIN_SEVERITY || "low").trim().toLowerCase();
  if (!(minSeverity in SEVERITY_RANK)) throw new Error(`min-severity must be one of low, medium, high, critical; got "${minSeverity}"`);
  const failOn = (env.TOCSIN_FAIL_ON || "affected").trim().toLowerCase();
  if (!FAIL_ON.includes(failOn)) throw new Error(`fail-on must be one of ${FAIL_ON.join(", ")}; got "${failOn}"`);
  const named = (/** @type {string} */ input, /** @type {string | undefined} */ v, /** @type {boolean} */ def) => {
    try {
      return bool(v, def);
    } catch (e) {
      throw new Error(`${input}: ${e instanceof Error ? e.message : e}`);
    }
  };
  return {
    baseUrl: (env.TOCSIN_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
    apiKey: env.TOCSIN_API_KEY || "",
    minSeverity,
    failOn,
    failOnError: named("fail-on-error", env.TOCSIN_FAIL_ON_ERROR, false),
    comment: named("comment", env.TOCSIN_COMMENT, true),
    dir: resolve(env.GITHUB_WORKSPACE || process.cwd(), env.TOCSIN_WORKING_DIRECTORY || "."),
    token: env.TOCSIN_GITHUB_TOKEN || "",
  };
}

// ---- workflow commands and files ------------------------------------------

/** Escapes a workflow-command message (%, CR, LF). @param {string} s */
const escapeCommand = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** @param {Io} io @param {"warning" | "error" | "notice"} level @param {string} msg */
const annotate = (io, level, msg) => io.out(`::${level} title=tocsin::${escapeCommand(msg)}`);

/** @param {string | undefined} path @param {string} text */
async function appendTo(path, text) {
  if (path) await appendFile(path, text);
}

// ---- the check --------------------------------------------------------------

/** @param {unknown} b @returns {b is CheckResult} */
function isCheckResult(b) {
  if (typeof b !== "object" || b === null) return false;
  const o = /** @type {Record<string, unknown>} */ (b);
  return typeof o.checked === "number" && Array.isArray(o.affected) && Array.isArray(o.skipped) && typeof o.feed_cursor === "number";
}

/** @param {number} status @param {unknown} body */
function describeFailure(status, body) {
  const err = typeof body === "object" && body !== null ? /** @type {{ error?: unknown }} */ (body).error : undefined;
  const msg = typeof err === "string" ? err : typeof body === "string" && body ? body.slice(0, 200) : "unexpected answer body";
  return `${status} ${msg}`;
}

/**
 * One multipart POST with every lockfile. Returns the result or a failure message.
 * @param {Io} io @param {Inputs} inputs @param {{ name: string; text: string }[]} files
 * @returns {Promise<{ ok: true; data: CheckResult } | { ok: false; error: string }>}
 */
export async function postCheck(io, inputs, files) {
  const form = new FormData();
  for (const f of files) form.append(f.name, new Blob([f.text], { type: "text/plain" }), f.name);
  /** @type {Record<string, string>} */
  const headers = { "User-Agent": `tocsin-action/${VERSION}`, Accept: "application/json" };
  if (inputs.apiKey) headers.Authorization = `Bearer ${inputs.apiKey}`;
  let res;
  try {
    res = await io.fetch(`${inputs.baseUrl}/v1/check`, { method: "POST", headers, body: form });
  } catch (e) {
    return { ok: false, error: `0 ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text().catch(() => "");
  let body = /** @type {unknown} */ (text);
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text for the message.
  }
  if (!res.ok || !isCheckResult(body)) return { ok: false, error: describeFailure(res.status, body) };
  return { ok: true, data: body };
}

/** True when the advisory is at or above min-severity. Unknown severity always counts. @param {Affected} a @param {string} min */
function atOrAbove(a, min) {
  const rank = SEVERITY_RANK[a.severity?.label ?? ""];
  return rank === undefined || rank >= SEVERITY_RANK[min];
}

/** @param {Affected[]} shown @param {string} failOn */
function failing(shown, failOn) {
  if (failOn === "never") return false;
  return failOn === "exploited" ? shown.some((a) => a.exploited) : shown.length > 0;
}

// ---- markdown ---------------------------------------------------------------

/** One safe table cell: no pipe, no newline, no HTML. @param {unknown} v */
export function cell(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} s */
const code = (s) => `\`${s.replace(/`/g, "")}\``;

/** @param {Affected} a */
function row(a) {
  const d = a.dependency ?? {};
  const sev = (a.severity?.label ?? "unknown") + (a.exploited ? ", exploited" : "");
  const id = cell(a.advisory_id ?? "?");
  const link = a.url && /^https?:\/\//.test(a.url) ? `[${id}](${a.url.replace(/[()\s]/g, encodeURIComponent)})` : id;
  const cmd = upgradeCommand(d.ecosystem ?? "", d.name ?? "", a.fixed_in);
  return `| ${cell(sev)} | ${cell(d.name)} | ${cell(d.version)} | ${cell(a.fixed_in ?? "none yet")} | ${link} | ${cell(a.action)} | ${cmd ? code(cmd) : "-"} |`;
}

/** @param {Skipped} s */
function skipLabel(s) {
  const what = s.dependency ? `${s.dependency.name ?? "?"}@${s.dependency.version ?? "?"}` : (s.file ?? s.raw ?? "an entry");
  const ids = s.advisory_ids?.length ? ` (${s.advisory_ids.join(", ")})` : "";
  return `${what}: ${s.reason ?? "not checked"}${ids}`;
}

/**
 * The markdown report, shared by the job summary and the PR comment.
 * @param {CheckResult} data @param {Affected[]} shown @param {Inputs} inputs
 */
export function report(data, shown, inputs) {
  const lines = ["### Tocsin check", ""];
  const skipped = data.skipped.length > 0 ? ` ${data.skipped.length} skipped (not checked, see below).` : "";
  if (shown.length === 0) {
    lines.push(`No known advisory affects the ${data.checked} checked dependencies.${skipped}`);
  } else {
    lines.push("| Severity | Package | Version | Fixed in | Advisory | Action | Upgrade |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const a of shown) lines.push(row(a));
    lines.push("", `${shown.length} of ${data.checked} dependencies affected (min severity ${inputs.minSeverity}).${skipped}`);
  }
  if (data.skipped.length > 0) {
    lines.push("", "Skipped, so not proved clean:", "");
    for (const s of data.skipped) lines.push(`- ${cell(skipLabel(s))}`);
  }
  lines.push("", `Source: ${inputs.baseUrl}/v1/check`);
  return lines.join("\n") + "\n";
}

// ---- the PR comment -----------------------------------------------------------

/** @param {Record<string, string | undefined>} env @returns {Promise<number | null>} */
async function prNumber(env) {
  if (env.GITHUB_EVENT_NAME !== "pull_request" && env.GITHUB_EVENT_NAME !== "pull_request_target") return null;
  if (!env.GITHUB_EVENT_PATH) return null;
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const n = event?.pull_request?.number;
  return Number.isInteger(n) ? n : null;
}

/**
 * Calls the GitHub REST API. Throws with the status on a non-2xx answer.
 * @param {Io} io @param {Inputs} inputs @param {string} method @param {string} path @param {unknown} [body]
 */
async function gh(io, inputs, method, path, body) {
  const base = (io.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/vnd.github+json", "User-Agent": `tocsin-action/${VERSION}`, Authorization: `Bearer ${inputs.token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await io.fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

/** The id of the marker comment on the PR, or null. @param {Io} io @param {Inputs} inputs @param {string} issue */
async function findMarkerComment(io, inputs, issue) {
  for (let page = 1; page <= COMMENT_PAGES; page++) {
    const list = /** @type {{ id: number; body?: string }[]} */ (await gh(io, inputs, "GET", `${issue}/comments?per_page=100&page=${page}`));
    const hit = list.find((c) => (c.body ?? "").includes(MARKER));
    if (hit) return hit.id;
    if (list.length < 100) return null;
  }
  return null;
}

/**
 * Posts or updates the one marker comment. A clean run only updates an existing one.
 * @param {Io} io @param {Inputs} inputs @param {string} markdown @param {boolean} clean
 */
export async function upsertComment(io, inputs, markdown, clean) {
  const pr = await prNumber(io.env);
  const repo = io.env.GITHUB_REPOSITORY;
  if (pr === null || !repo) return;
  const issue = `/repos/${repo}/issues/${pr}`;
  const id = await findMarkerComment(io, inputs, issue);
  const body = `${MARKER}\n${markdown}`;
  if (id !== null) await gh(io, inputs, "PATCH", `/repos/${repo}/issues/comments/${id}`, { body });
  else if (!clean) await gh(io, inputs, "POST", `${issue}/comments`, { body });
}

// ---- run ------------------------------------------------------------------

/** The could-not-run path: a warning (or an error with fail-on-error) and the summary. @param {Io} io @param {Inputs} inputs @param {string} msg */
async function couldNotRun(io, inputs, msg) {
  annotate(io, inputs.failOnError ? "error" : "warning", `check could not run: ${msg}`);
  await appendTo(io.env.GITHUB_STEP_SUMMARY, `### Tocsin check\n\nThe check could not run: ${cell(msg)}. This is not a clean result.\n`);
  return inputs.failOnError ? 1 : 0;
}

/** @param {Io} io @param {Inputs} inputs @param {CheckResult} data */
async function finish(io, inputs, data) {
  const shown = data.affected.filter((a) => atOrAbove(a, inputs.minSeverity));
  for (const s of data.skipped) annotate(io, "warning", `not checked, so not proved clean: ${skipLabel(s)}`);
  const markdown = report(data, shown, inputs);
  await appendTo(io.env.GITHUB_STEP_SUMMARY, markdown);
  await appendTo(io.env.GITHUB_OUTPUT, `affected=${shown.length}\n`);
  if (inputs.comment) {
    try {
      await upsertComment(io, inputs, markdown, shown.length === 0);
    } catch (e) {
      annotate(io, "warning", `could not post the PR comment: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (shown.length > 0) io.out(`${shown.length} of ${data.checked} dependencies affected.`);
  return failing(shown, inputs.failOn) ? 1 : 0;
}

/**
 * Runs the Action once. Returns the exit code.
 * @param {Io} io
 * @returns {Promise<number>}
 */
export async function run(io) {
  let inputs;
  try {
    inputs = readInputs(io.env);
  } catch (e) {
    annotate(io, "error", `invalid input: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  let files;
  try {
    files = await findLockfiles(inputs.dir);
  } catch (e) {
    return couldNotRun(io, inputs, `cannot read ${inputs.dir}: ${e instanceof Error ? e.message : e}`);
  }
  if (files.length === 0) return couldNotRun(io, inputs, `no lockfile in ${inputs.dir} (looked for ${LOCKFILE_NAMES.join(", ")}, requirements-*.txt)`);
  const answer = await postCheck(io, inputs, files);
  if (!answer.ok) return couldNotRun(io, inputs, answer.error);
  return finish(io, inputs, answer.data);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await run({ env: process.env, fetch: (u, i) => fetch(u, i), out: (l) => console.log(l) });
}
