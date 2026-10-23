import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { runCheck } from "../check/run";
import {
  LockfileParseError,
  ResultBuilder,
  SUPPORTED_FILENAMES,
  detect,
  parseOsPackages,
  parseRuntimes,
  type Dependency,
  type ParseResult,
} from "../check/parsers";
import { OS_NAMES, osEcosystem, type OsName } from "../check/parsers/os-packages";
import { RUNTIMES } from "../check/parsers/runtimes";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";
import { checkRateLimit } from "../middleware/ratelimit";

// Code fallback only. The live cap is settings.check.max_body_bytes.
export const FALLBACK_MAX_BODY_BYTES = 2 * 1024 * 1024;
const ACCEPTED = ["multipart/form-data", "application/json"];
// A cached check could hide an advisory published after it.
const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = Context<{ Bindings: Env }>;

const answer = (c: Ctx, body: unknown, status: ContentfulStatusCode = 200) => jsonUtf8(c, body, status, NO_STORE);

class BadRequest extends Error {
  constructor(readonly body: Record<string, unknown>) {
    super(String(body.error));
    this.name = "BadRequest";
  }
}

interface Input {
  dependencies: Dependency[];
  skipped: object[];
}

const check = new Hono<{ Bindings: Env }>();

check.use("*", checkRateLimit);

check.get("/", async (c) => {
  const params: Record<string, string> = {};
  for (const [k, v] of new URL(c.req.url).searchParams) if (!(k in params)) params[k] = v;
  // A query string has no room for a package list (TCS-38).
  const os = OS_NAMES.find((k) => k in params);
  if (os !== undefined) return answer(c, { error: `${os}= needs os_packages; send it with POST /v1/check`, field: "os_packages" }, 400);
  const parsed = parseRuntimes(params);
  if (parsed.dependencies.length === 0) {
    return answer(c, { error: "no runtime version in the query, for example ?node=24.22.0", supported_runtimes: RUNTIMES, skipped: parsed.skipped }, 400);
  }
  return answer(c, await runCheck(c.env.DB, parsed.dependencies, parsed.skipped));
});

check.post(
  "/",
  async (c, next) => {
    const maxSize = await getSettingInt(c.env.DB, "check.max_body_bytes", FALLBACK_MAX_BODY_BYTES);
    return bodyLimit({ maxSize, onError: (c) => answer(c, { error: `body over ${maxSize} bytes` }, 413) })(c, next);
  },
  async (c) => {
    const type = (c.req.header("Content-Type") ?? "").toLowerCase();
    let input: Input;
    try {
      if (type.startsWith("multipart/form-data")) input = await fromMultipart(c);
      else if (type.startsWith("application/json")) input = await fromJson(c);
      else return answer(c, { error: "unsupported content type", accepted: ACCEPTED }, 415);
    } catch (err) {
      if (err instanceof BadRequest) return answer(c, err.body, 400);
      throw err;
    }
    return answer(c, await runCheck(c.env.DB, input.dependencies, input.skipped));
  },
);

async function fromMultipart(c: Ctx): Promise<Input> {
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw new BadRequest({ error: "invalid multipart body" });
  }
  const dependencies: Dependency[] = [];
  const skipped: object[] = [];
  // The OS fields (TCS-38) are not lockfiles: alpine / debian (the release) and os_packages (the list).
  const osFields: Record<string, unknown> = {};
  for (const key of [...OS_NAMES, "os_packages"]) {
    const value = form.get(key);
    if (value !== null) osFields[key] = typeof value === "string" ? value : await value.text();
  }
  const os = readOs(osFields, osFields.os_packages);
  if (os) dependencies.push(...os.dependencies);
  for (const s of os?.skipped ?? []) skipped.push({ file: "os_packages", ...s });
  let files = 0;
  for (const [key, value] of form.entries()) {
    if (key in osFields) continue;
    files++;
    const text = typeof value === "string" ? value : await value.text();
    let found;
    try {
      found = detect(key, text);
    } catch (err) {
      if (err instanceof LockfileParseError) throw new BadRequest({ error: err.message, file: key });
      throw err;
    }
    if (found === null) {
      throw new BadRequest({ error: "unsupported lockfile name", file: key, supported_filenames: SUPPORTED_FILENAMES });
    }
    dependencies.push(...found.result.dependencies);
    for (const s of found.result.skipped) skipped.push({ file: key, ...s });
  }
  if (files === 0 && !os) {
    throw new BadRequest({ error: "no lockfile in the form; the field name is the file name", supported_filenames: SUPPORTED_FILENAMES });
  }
  return { dependencies: dedupe(dependencies), skipped };
}

async function fromJson(c: Ctx): Promise<Input> {
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    throw new BadRequest({ error: "invalid JSON" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest({ error: "body must be a JSON object { dependencies, runtimes }" });
  }
  const { dependencies, runtimes, os_packages } = body as { dependencies?: unknown; runtimes?: unknown; os_packages?: unknown };
  if (dependencies !== undefined && !Array.isArray(dependencies)) {
    throw new BadRequest({ error: "dependencies must be an array of { ecosystem, name, version }" });
  }
  if (runtimes !== undefined && (typeof runtimes !== "object" || runtimes === null || Array.isArray(runtimes))) {
    throw new BadRequest({ error: "runtimes must be an object, for example { \"node\": \"24.22.0\" }" });
  }
  if (dependencies === undefined && runtimes === undefined && os_packages === undefined) {
    throw new BadRequest({ error: "send dependencies, runtimes or both" });
  }
  // runtimes.alpine / runtimes.debian name the release of os_packages (TCS-38); they are not runtimes.
  const rtInput: Record<string, unknown> = { ...((runtimes as Record<string, unknown> | undefined) ?? {}) };
  const osRelease: Record<string, unknown> = {};
  for (const k of OS_NAMES) {
    if (k in rtInput) {
      osRelease[k] = rtInput[k];
      delete rtInput[k];
    }
  }
  const os = readOs(osRelease, os_packages);

  const out = new ResultBuilder();
  const skipped: object[] = [];
  for (const item of dependencies ?? []) {
    const d = item as Partial<Record<keyof Dependency, unknown>> | null;
    if (!isNonEmpty(d?.ecosystem) || !isNonEmpty(d?.name) || !isNonEmpty(d?.version)) {
      skipped.push({ raw: JSON.stringify(item), reason: "invalid dependency" });
      continue;
    }
    out.add(d.ecosystem, d.name, d.version);
  }
  const rt = runtimes === undefined ? { dependencies: [], skipped: [] } : parseRuntimes(rtInput);
  for (const dep of rt.dependencies) out.add(dep.ecosystem, dep.name, dep.version);
  skipped.push(...rt.skipped);
  for (const dep of os?.dependencies ?? []) out.add(dep.ecosystem, dep.name, dep.version);
  for (const s of os?.skipped ?? []) skipped.push({ file: "os_packages", ...s });
  return { dependencies: out.build().dependencies, skipped };
}

// An OS package list (TCS-38): exactly one of alpine / debian (the release)
// plus os_packages (apk list --installed, dpkg -l or dpkg-query -W text).
// No OS key and no list: null. Any other shape is a 400 that names the field.
function readOs(release: Record<string, unknown>, packages: unknown): ParseResult | null {
  const present = OS_NAMES.filter((k) => release[k] !== undefined);
  if (present.length === 0) {
    if (packages === undefined) return null;
    throw new BadRequest({ error: "os_packages needs its release: alpine or debian", field: "os_packages" });
  }
  if (present.length > 1) throw new BadRequest({ error: "send alpine or debian, not both", field: "alpine" });
  const os: OsName = present[0];
  const rel = release[os];
  if (typeof rel !== "string") throw new BadRequest({ error: `${os} must be the release as a string, for example "${os === "alpine" ? "3.18" : "12"}"`, field: os });
  if (packages === undefined) throw new BadRequest({ error: `${os} needs os_packages, the installed package list`, field: "os_packages" });
  if (typeof packages !== "string" || packages.trim() === "") {
    throw new BadRequest({ error: "os_packages must be the text of apk list --installed, dpkg -l or dpkg-query -W", field: "os_packages" });
  }
  if (osEcosystem(os, rel) === null) throw new BadRequest({ error: `${os}: unknown release ${JSON.stringify(rel)}`, field: os });
  try {
    return parseOsPackages(os, rel, packages);
  } catch (err) {
    if (err instanceof LockfileParseError) throw new BadRequest({ error: err.message, field: "os_packages" });
    throw err;
  }
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function dedupe(deps: Dependency[]): Dependency[] {
  const out = new ResultBuilder();
  for (const d of deps) out.add(d.ecosystem, d.name, d.version);
  return out.build().dependencies;
}

export default check;
