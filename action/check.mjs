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
// The hosted API's body limit (setting `check.max_body_bytes`). Documented
// fallback; a self-hoster with another limit sets the `max-body-bytes` input.
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
// Bounds that keep a PR comment under GitHub's 65536-character body limit.
const MAX_SKIP_ROWS = 50;
const MAX_AFFECTED_ROWS = 200;
const MAX_REPORT_CHARS = 60_000;
const MAX_SKIP_ANNOTATIONS = 10;
// The login of the default GITHUB_TOKEN, which cannot read GET /user.
const DEFAULT_BOT = "github-actions[bot]";

/**
 * @typedef {{ env: Record<string, string | undefined>; fetch: (url: string, init?: RequestInit) => Promise<Response>; out: (line: string) => void }} Io
 * @typedef {{ ecosystem?: string; name?: string; version?: string }} Dependency
 * @typedef {{ dependency?: Dependency; advisory_id?: string; severity?: { label?: string }; exploited?: boolean; fixed_in?: string | null; action?: string; url?: string }} Affected
 * @typedef {{ dependency?: Dependency; file?: string; raw?: string; reason?: string; advisory_ids?: string[] }} Skipped
 * @typedef {{ checked: number; affected: Affected[]; skipped: Skipped[]; feed_cursor: number }} CheckResult
 * @typedef {{ baseUrl: string; apiKey: string; minSeverity: string; failOn: string; failOnError: boolean; comment: boolean; dir: string; token: string; maxBodyBytes: number }} Inputs
 */

const UPGRADE = /** @type {Record<string, (name: string, v: string) => string>} */ ({
  npm: (n, v) => `npm i ${n}@${v}`,
  PyPI: (n, v) => `pip install ${n}==${v}`,
  Go: (n, v) => `go get ${n}@${v.startsWith("v") ? v : `v${v}`}`,
  Packagist: (n, v) => `composer require ${n}:${v}`,
  // --precise: plain `cargo update -p` stays inside the Cargo.toml range and can stop below the fix.
  "crates.io": (n, v) => `cargo update -p ${n} --precise ${v}`,
  RubyGems: (n) => `bundle update ${n}`,
});

/**
 * The upgrade command for one dependency, or null when there is no fixed version or no known tool.
 * @param {string} ecosystem @param {string} name @param {string | null | undefined} fixed
 * @returns {string | null}
 */
export function upgradeCommand(ecosystem, name, fixed) {
  if (isGoToolchain(ecosystem, name)) return null;
  const f = Object.hasOwn(UPGRADE, ecosystem) ? UPGRADE[ecosystem] : undefined;
  return f && fixed ? f(name, fixed) : null;
}

/** Go's standard library and toolchain ship with Go itself: `go get` cannot upgrade them. @param {string} ecosystem @param {string} name */
function isGoToolchain(ecosystem, name) {
  return ecosystem === "Go" && (name === "stdlib" || name === "toolchain" || name.startsWith("cmd/"));
}

/**
 * The Upgrade cell: a command in a code span, a plain instruction for the Go toolchain, or "-".
 * @param {string} ecosystem @param {string} name @param {string | null | undefined} fixed
 * @returns {string}
 */
export function upgradeCell(ecosystem, name, fixed) {
  if (isGoToolchain(ecosystem, name)) return fixed ? cell(`Upgrade Go to ${fixed.replace(/^v/, "")}`) : "-";
  const cmd = safeForCommand(name, fixed) ? upgradeCommand(ecosystem, name, fixed) : null;
  return cmd ? code(cmd) : "-";
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
    maxBodyBytes: positiveInt("max-body-bytes", env.TOCSIN_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
  };
}

/** @param {string} input @param {string | undefined} v @param {number} def */
function positiveInt(input, v, def) {
  const s = (v ?? "").trim();
  if (s === "") return def;
  if (!/^[1-9]\d{0,9}$/.test(s)) throw new Error(`${input} must be a positive whole number of bytes; got "${v}"`);
  return Number(s);
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
  return (
    typeof o.checked === "number" &&
    typeof o.feed_cursor === "number" &&
    Array.isArray(o.affected) &&
    o.affected.every(isAffected) &&
    Array.isArray(o.skipped) &&
    o.skipped.every(isSkipped)
  );
}

/** @param {unknown} v */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const optString = (v) => v === undefined || v === null || typeof v === "string";

/** @param {unknown} d */
function isDependency(d) {
  if (d === undefined) return true;
  if (!isObject(d)) return false;
  const o = /** @type {Record<string, unknown>} */ (d);
  return optString(o.ecosystem) && optString(o.name) && optString(o.version);
}

/** @param {unknown} a */
function isAffected(a) {
  if (!isObject(a)) return false;
  const o = /** @type {Record<string, unknown>} */ (a);
  const sev = o.severity === undefined || (isObject(o.severity) && optString(/** @type {{ label?: unknown }} */ (o.severity).label));
  return isDependency(o.dependency) && sev && optString(o.advisory_id) && optString(o.fixed_in) && optString(o.action) && optString(o.url);
}

/** @param {unknown} s */
function isSkipped(s) {
  if (!isObject(s)) return false;
  const o = /** @type {Record<string, unknown>} */ (s);
  const ids = o.advisory_ids === undefined || (Array.isArray(o.advisory_ids) && o.advisory_ids.every((x) => typeof x === "string"));
  return isDependency(o.dependency) && optString(o.file) && optString(o.raw) && optString(o.reason) && ids;
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
//
// Every string that comes from the lockfile, the API or the advisory goes
// through cell(): a PR author controls lockfile text, and the comment is
// posted under the bot's name. cell() makes HTML, Markdown links, images,
// emphasis, code spans, @mentions, #references and autolinks inert, and keeps
// the text readable. A word joiner (U+2060) breaks a mention or an autolink
// without a visible change.

const WJ = "\u2060";
const MAX_CELL_CHARS = 500;

/** One safe table cell: no pipe, no newline, no HTML, no live Markdown. @param {unknown} v */
export function cell(v) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  const short = s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}...` : s;
  return short
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_~[\]()!|]/g, "\\$&")
    .replace(/[@#]/g, `$&${WJ}`)
    .replace(/:\/\//g, `:${WJ}//`)
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}${WJ}.`);
}

// A command is shown only when the name and version are plain package text;
// anything else gets "-" so a crafted name cannot ride into a code span.
const SAFE_NAME = /^[A-Za-z0-9@/._+~:-]{1,214}$/;
const SAFE_VERSION = /^[A-Za-z0-9._+~-]{1,64}$/;

/** @param {string} s */
const code = (s) => `\`${s}\``;

/** @param {string} name @param {string | null | undefined} fixed */
const safeForCommand = (name, fixed) => SAFE_NAME.test(name) && (fixed == null || SAFE_VERSION.test(fixed));

/** @param {string | undefined} url */
function advisoryHref(url) {
  if (!url || !/^https?:\/\/[^\s]+$/.test(url)) return null;
  return url.replace(/[()<>\[\]`"'\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** @param {Affected} a */
function row(a) {
  const d = a.dependency ?? {};
  const sev = (a.severity?.label ?? "unknown") + (a.exploited ? ", exploited" : "");
  const id = cell(a.advisory_id ?? "?");
  const href = advisoryHref(a.url);
  const link = href ? `[${id}](${href})` : id;
  const upgrade = upgradeCell(d.ecosystem ?? "", d.name ?? "", a.fixed_in);
  return `| ${cell(sev)} | ${cell(d.name)} | ${cell(d.version)} | ${cell(a.fixed_in ?? "none yet")} | ${link} | ${cell(a.action)} | ${upgrade} |`;
}

/** @param {Skipped} s */
function skipLabel(s) {
  const dep = s.dependency ? `${s.dependency.name ?? "?"}@${s.dependency.version ?? "?"}` : "";
  const where = [s.file, s.raw].filter(Boolean).join(": ");
  const what = [dep, where].filter(Boolean).join(" in ") || "an entry";
  const ids = s.advisory_ids?.length ? ` (${s.advisory_ids.join(", ")})` : "";
  return `${what}: ${s.reason ?? "not checked"}${ids}`;
}

/** @param {string[]} lines @param {string[]} items @param {number} max @param {string} more */
function pushCapped(lines, items, max, more) {
  lines.push(...items.slice(0, max));
  if (items.length > max) lines.push(`+${items.length - max} more ${more}`);
}

/** Cuts the report at a line boundary under MAX_REPORT_CHARS. @param {string} text */
function capReport(text) {
  if (text.length <= MAX_REPORT_CHARS) return text;
  const cut = text.lastIndexOf("\n", MAX_REPORT_CHARS);
  return `${text.slice(0, cut)}\n\n(Report cut at ${MAX_REPORT_CHARS} characters. The job log has every annotation.)\n`;
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
    pushCapped(lines, shown.map(row), MAX_AFFECTED_ROWS, "affected (rows not shown)");
    lines.push("", `${shown.length} of ${data.checked} dependencies affected (min severity ${inputs.minSeverity}).${skipped}`);
  }
  if (data.skipped.length > 0) {
    lines.push("", "Skipped, so not proved clean:", "");
    pushCapped(lines, data.skipped.map((s) => `- ${cell(skipLabel(s))}`), MAX_SKIP_ROWS, "skipped (not shown)");
  }
  lines.push("", `Source: ${inputs.baseUrl}/v1/check`);
  return capReport(lines.join("\n") + "\n");
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

/**
 * Who the token posts as. A user or app token answers GET /user; the default
 * GITHUB_TOKEN cannot, and it posts as the github-actions[bot] Bot account.
 * @param {Io} io @param {Inputs} inputs
 * @returns {Promise<{ login: string; bot: boolean }>}
 */
async function viewer(io, inputs) {
  try {
    const u = await gh(io, inputs, "GET", "/user");
    if (typeof u?.login === "string" && u.login) return { login: u.login, bot: false };
  } catch {
    // The default token: fall back to the bot identity below.
  }
  return { login: DEFAULT_BOT, bot: true };
}

/**
 * The id of OUR marker comment on the PR, or null. A marker comment by anyone
 * else is ignored, so a PR author cannot make the bot edit their comment.
 * @param {Io} io @param {Inputs} inputs @param {string} issue
 */
async function findMarkerComment(io, inputs, issue) {
  const me = await viewer(io, inputs);
  /** @param {{ body?: string; user?: { login?: string; type?: string } }} c */
  const ours = (c) => (c.body ?? "").includes(MARKER) && c.user?.login === me.login && (!me.bot || c.user?.type === "Bot");
  for (let page = 1; page <= COMMENT_PAGES; page++) {
    const list = /** @type {{ id: number; body?: string; user?: { login?: string; type?: string } }[]} */ (
      await gh(io, inputs, "GET", `${issue}/comments?per_page=100&page=${page}`)
    );
    const hit = list.find(ours);
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

/** @param {unknown} e */
const message = (e) => (e instanceof Error ? e.message : String(e));

/** The could-not-run path: a warning (or an error with fail-on-error) and the summary. @param {Io} io @param {Inputs} inputs @param {string} msg */
async function couldNotRun(io, inputs, msg) {
  annotate(io, inputs.failOnError ? "error" : "warning", `check could not run: ${msg}`);
  try {
    await appendTo(io.env.GITHUB_STEP_SUMMARY, `### Tocsin check\n\nThe check could not run: ${cell(msg)}. This is not a clean result.\n`);
  } catch {
    // The annotation above already says it; a broken summary file changes nothing.
  }
  return inputs.failOnError ? 1 : 0;
}

/**
 * Splits the lockfiles into the ones that fit in max-body-bytes (in name
 * order) and the ones that do not. 512 bytes per file covers the multipart
 * headers.
 * @param {{ name: string; text: string }[]} files @param {number} max
 */
export function fitBody(files, max) {
  /** @type {{ name: string; text: string }[]} */
  const send = [];
  /** @type {{ name: string; bytes: number }[]} */
  const over = [];
  let total = 0;
  for (const f of files) {
    const bytes = Buffer.byteLength(f.text, "utf8");
    if (total + bytes + 512 <= max) {
      send.push(f);
      total += bytes + 512;
    } else over.push({ name: f.name, bytes });
  }
  return { send, over };
}

/** @param {Io} io @param {CheckResult} data */
function annotateSkips(io, data) {
  for (const s of data.skipped.slice(0, MAX_SKIP_ANNOTATIONS)) annotate(io, "warning", `not checked, so not proved clean: ${skipLabel(s)}`);
  const rest = data.skipped.length - MAX_SKIP_ANNOTATIONS;
  if (rest > 0) annotate(io, "warning", `${rest} more not checked, so not proved clean; the job summary lists them`);
}

/** @param {Io} io @param {Inputs} inputs @param {CheckResult} data */
async function finish(io, inputs, data) {
  const shown = data.affected.filter((a) => atOrAbove(a, inputs.minSeverity));
  annotateSkips(io, data);
  const markdown = report(data, shown, inputs);
  await appendTo(io.env.GITHUB_STEP_SUMMARY, markdown);
  await appendTo(io.env.GITHUB_OUTPUT, `affected=${shown.length}\n`);
  if (inputs.comment) {
    try {
      await upsertComment(io, inputs, markdown, shown.length === 0);
    } catch (e) {
      annotate(io, "warning", `could not post the PR comment: ${message(e)}`);
    }
  }
  if (shown.length > 0) io.out(`${shown.length} of ${data.checked} dependencies affected.`);
  return failing(shown, inputs.failOn) ? 1 : 0;
}

/** @param {Io} io @param {Inputs} inputs */
async function check(io, inputs) {
  const files = await findLockfiles(inputs.dir);
  if (files.length === 0) return couldNotRun(io, inputs, `no lockfile in ${inputs.dir} (looked for ${LOCKFILE_NAMES.join(", ")}, requirements-*.txt)`);
  const { send, over } = fitBody(files, inputs.maxBodyBytes);
  const overNames = over.map((f) => `${f.name} (${f.bytes} bytes)`).join(", ");
  if (send.length === 0) return couldNotRun(io, inputs, `every lockfile is over max-body-bytes ${inputs.maxBodyBytes}: ${overNames}`);
  if (over.length > 0) annotate(io, "warning", `not sent, over max-body-bytes ${inputs.maxBodyBytes}: ${overNames}`);
  const answer = await postCheck(io, inputs, send);
  if (!answer.ok) return couldNotRun(io, inputs, answer.error);
  const tooBig = over.map((f) => ({ file: f.name, reason: `not sent: ${f.bytes} bytes is over max-body-bytes ${inputs.maxBodyBytes}` }));
  return finish(io, inputs, { ...answer.data, skipped: [...tooBig, ...answer.data.skipped] });
}

/**
 * Runs the Action once. Returns the exit code. Any unexpected throw is the
 * could-not-run path, never a crash and never a clean result.
 * @param {Io} io
 * @returns {Promise<number>}
 */
export async function run(io) {
  let inputs;
  try {
    inputs = readInputs(io.env);
  } catch (e) {
    annotate(io, "error", `invalid input: ${message(e)}`);
    return 1;
  }
  try {
    return await check(io, inputs);
  } catch (e) {
    return couldNotRun(io, inputs, message(e));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await run({ env: process.env, fetch: (u, i) => fetch(u, i), out: (l) => console.log(l) });
}
