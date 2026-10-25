// `tocsin connect`: add the Tocsin MCP server to each agent tool on this
// machine, and the Tocsin skill to Claude Code, Codex and Cursor. It reads each
// config file, edits one key, and writes it back through a temp file and a
// rename. It never writes a file it cannot parse, never replaces a user's own
// `tocsin` entry or edited skill copy, and never writes the API key.
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Io } from "./io.js";
import { DEFAULT_MCP_URL, mcpServerConfig } from "./mcp-config.js";
import { PKG_ROOT } from "./version.js";

type Kind = "json" | "toml" | "skill" | "skill-copy" | "hook";

interface Target {
  name: string;
  flag: string;
  kind: Kind;
  /** The config file. Null when this machine has no path for the target. */
  path: string | null;
  detected: boolean;
  entry?: unknown;
  /** For kind "skill-copy": the packaged file under skills/. */
  src?: string;
}

type Outcome = "connected" | "already" | "different" | "failed";

interface Plan {
  outcome: Outcome;
  /** The new file content when the outcome is "connected". */
  next?: string | Buffer;
  reason?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

const block = (entry: unknown) => JSON.stringify({ mcpServers: { tocsin: entry } }, null, 2);

/** The command the Claude Code SessionStart hook runs. `check --summary` prints one line and exits 0. */
export const HOOK_COMMAND = "npx -y tocsin check --summary";
const HOOK_ENTRY = { matcher: "startup", hooks: [{ type: "command", command: HOOK_COMMAND }] };
const hookBlock = () => JSON.stringify({ hooks: { SessionStart: [HOOK_ENTRY] } }, null, 2);

/** The Claude Code plugin (plugins/tocsin): skill, MCP server and SessionStart check in one install. Connect prints it after a Claude Code wire. */
export const PLUGIN_INSTALL_COMMAND = "claude plugin install tocsin --marketplace Fortunian/tocsin";

/** The block `connect --print-agents-md` prints for a repo's AGENTS.md. */
export const AGENTS_MD_BLOCK = [
  "## Security advisories (Tocsin)",
  "",
  "At session start and before a deploy, run `npx tocsin check --json`.",
  "Exit 1: a dependency has an advisory. Read `affected[]` and upgrade to `fixed_in`.",
  "Exit 3: the check failed. Do not report the project as safe.",
  "Docs: https://tocsin.sh/docs",
].join("\n");

function homeDir(io: Io): string | null {
  return (io.platform === "win32" ? io.env.USERPROFILE || io.env.HOME : io.env.HOME || io.env.USERPROFILE) || null;
}

/** A packaged file under skills/: inside the published package, else in the repo checkout. */
export function skillSource(rel = "tocsin/SKILL.md"): { path: string; found: boolean } {
  const published = fileURLToPath(new URL(`skills/${rel}`, PKG_ROOT));
  if (existsSync(published)) return { path: published, found: true };
  const repo = fileURLToPath(new URL(`../../skills/${rel}`, PKG_ROOT));
  if (existsSync(repo)) return { path: repo, found: true };
  return { path: published, found: false };
}

function targets(io: Io, home: string, mcpUrl: string): Target[] {
  const exists = (p: string) => existsSync(p);
  const claudeJson = join(home, ".claude.json");
  const claudeDetected = exists(claudeJson) || exists(join(home, ".claude"));

  const macDesktop = join(home, "Library", "Application Support", "Claude");
  const winDesktop = io.env.APPDATA ? join(io.env.APPDATA, "Claude") : null;
  let desktopDir: string | null = null;
  let desktopDetected = false;
  if (exists(macDesktop)) [desktopDir, desktopDetected] = [macDesktop, true];
  else if (winDesktop && exists(winDesktop)) [desktopDir, desktopDetected] = [winDesktop, true];
  else if (io.platform === "darwin") desktopDir = macDesktop;
  else if (io.platform === "win32") desktopDir = winDesktop;

  return [
    { name: "Claude Code", flag: "claude-code", kind: "json", path: claudeJson, detected: claudeDetected, entry: mcpServerConfig(mcpUrl) },
    { name: "Claude Code skill", flag: "claude-code", kind: "skill", path: join(home, ".claude", "skills", "tocsin", "SKILL.md"), detected: claudeDetected },
    { name: "Cursor", flag: "cursor", kind: "json", path: join(home, ".cursor", "mcp.json"), detected: exists(join(home, ".cursor")), entry: { url: mcpUrl } },
    {
      name: "Claude Desktop",
      flag: "claude-desktop",
      kind: "json",
      path: desktopDir ? join(desktopDir, "claude_desktop_config.json") : null,
      detected: desktopDetected,
      entry: { command: "npx", args: ["-y", "mcp-remote", mcpUrl] },
    },
    { name: "Codex", flag: "codex", kind: "toml", path: join(home, ".codex", "config.toml"), detected: exists(join(home, ".codex")) },
    {
      name: "Codex skill",
      flag: "codex",
      kind: "skill-copy",
      path: join(home, ".codex", "skills", "tocsin", "SKILL.md"),
      detected: exists(join(home, ".codex")),
      src: "codex/tocsin/SKILL.md",
    },
    { name: "Cursor rule", flag: "cursor", kind: "skill-copy", path: join(home, ".cursor", "rules", "tocsin.mdc"), detected: exists(join(home, ".cursor")), src: "cursor/tocsin.mdc" },
    { name: "Claude Code hook", flag: "claude-code", kind: "hook", path: join(home, ".claude", "settings.json"), detected: claudeDetected },
  ];
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function planJson(current: Buffer | null, entry: unknown): Plan {
  if (current === null) return { outcome: "connected", next: JSON.stringify({ mcpServers: { tocsin: entry } }, null, 2) + "\n" };
  const text = current.toString("utf8").replace(/^﻿/, "");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { outcome: "failed", reason: "could not parse" };
  }
  if (!isObject(obj)) return { outcome: "failed", reason: "could not parse" };
  const servers = obj.mcpServers;
  if (servers !== undefined && !isObject(servers)) return { outcome: "failed", reason: "could not parse" };
  if (servers && "tocsin" in servers) return { outcome: deepEqual(servers.tocsin, entry) ? "already" : "different" };
  obj.mcpServers = { ...(servers ?? {}), tocsin: entry };
  const newline = /\r?\n$/.exec(text)?.[0] ?? "";
  return { outcome: "connected", next: JSON.stringify(obj, null, 2) + newline };
}

const TOML_HEADER = /^\s*\[mcp_servers\.("?)tocsin\1\]/;

function planToml(current: Buffer | null, mcpUrl: string): Plan {
  const table = `[mcp_servers.tocsin]\nurl = "${mcpUrl}"\n`;
  if (current === null) return { outcome: "connected", next: table };
  const text = current.toString("utf8");
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => TOML_HEADER.test(l));
  if (at >= 0) {
    // The table exists. It is ours only when its url is the same.
    for (const line of lines.slice(at + 1)) {
      if (/^\s*\[/.test(line)) break;
      const m = /^\s*url\s*=\s*"([^"]*)"/.exec(line);
      if (m) return { outcome: m[1] === mcpUrl ? "already" : "different" };
    }
    return { outcome: "different" };
  }
  return { outcome: "connected", next: text + (text === "" || text.endsWith("\n") ? "\n" : "\n\n") + table };
}

async function planSkill(current: Buffer | null): Promise<Plan> {
  const src = skillSource();
  if (!src.found) return { outcome: "failed", reason: `the packaged skill is missing (${src.path})` };
  const bytes = await readFile(src.path);
  if (current !== null && current.equals(bytes)) return { outcome: "already" };
  return { outcome: "connected", next: bytes };
}

/** A generated skill copy. A file that differs from ours is the user's: never replaced. */
async function planSkillCopy(current: Buffer | null, rel: string): Promise<Plan> {
  const src = skillSource(rel);
  if (!src.found) return { outcome: "failed", reason: `the packaged skill is missing (${src.path})` };
  const bytes = await readFile(src.path);
  if (current === null) return { outcome: "connected", next: bytes };
  return { outcome: current.equals(bytes) ? "already" : "different" };
}

/** Add HOOK_ENTRY to hooks.SessionStart in ~/.claude/settings.json, keeping every other key. */
function planHook(current: Buffer | null): Plan {
  if (current === null) return { outcome: "connected", next: hookBlock() + "\n" };
  const text = current.toString("utf8").replace(/^\uFEFF/, "");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { outcome: "failed", reason: "could not parse" };
  }
  if (!isObject(obj)) return { outcome: "failed", reason: "could not parse" };
  const hooks = obj.hooks;
  if (hooks !== undefined && !isObject(hooks)) return { outcome: "failed", reason: "could not parse" };
  const start = hooks?.SessionStart;
  if (start !== undefined && !Array.isArray(start)) return { outcome: "failed", reason: "could not parse" };
  const commands = (start ?? []).flatMap((e: unknown) =>
    isObject(e) && Array.isArray(e.hooks) ? e.hooks.map((h: unknown) => (isObject(h) && typeof h.command === "string" ? h.command : "")) : [],
  );
  if (commands.includes(HOOK_COMMAND)) return { outcome: "already" };
  if (commands.some((c) => c.includes("tocsin check"))) return { outcome: "different" };
  obj.hooks = { ...(hooks ?? {}), SessionStart: [...(start ?? []), HOOK_ENTRY] };
  const newline = /\r?\n$/.exec(text)?.[0] ?? "";
  return { outcome: "connected", next: JSON.stringify(obj, null, 2) + newline };
}

/** Write through a temp file in the same directory and a rename, keeping the file mode. */
async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = await stat(path).then((s) => s.mode & 0o777, () => null);
  const tmp = `${path}.tocsin-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(tmp, data, mode === null ? undefined : { mode });
    if (mode !== null) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

export async function runConnect(io: Io, values: Record<string, unknown>): Promise<number> {
  const mcpUrl = io.env.TOCSIN_MCP_URL || DEFAULT_MCP_URL;
  const generic = mcpServerConfig(mcpUrl);

  if (values.print) {
    io.out(block(generic));
    return 0;
  }
  if (values["print-agents-md"]) {
    io.out(AGENTS_MD_BLOCK);
    return 0;
  }

  const home = homeDir(io);
  if (!home) {
    io.err("tocsin connect: HOME is not set");
    return 2;
  }

  // The SessionStart hook is opt-in: without --hook, settings.json is never read.
  const all = targets(io, home, mcpUrl).filter((t) => t.kind !== "hook" || values.hook === true);
  const flags = new Set(all.map((t) => t.flag).filter((f) => values[f] === true));
  const chosen = flags.size > 0 ? all.filter((t) => flags.has(t.flag)) : all.filter((t) => t.detected);

  if (chosen.length === 0) {
    io.out("no agent tool found (Claude Code, Cursor, Claude Desktop, Codex). Add this block to your tool's MCP config:");
    io.out(block(generic));
    return 0;
  }

  const dryRun = values["dry-run"] === true;
  let failed = 0;
  let already = 0;
  let claudeCodeWired = false;
  for (const t of chosen) {
    if (t.path === null) {
      failed++;
      io.out(`${t.name}: no config path on this machine (${io.platform}); add this block by hand:`);
      io.out(block(t.entry));
      continue;
    }
    let plan: Plan;
    try {
      const current = await readIfPresent(t.path);
      if (t.kind === "json") plan = planJson(current, t.entry);
      else if (t.kind === "toml") plan = planToml(current, mcpUrl);
      else if (t.kind === "skill-copy") plan = await planSkillCopy(current, t.src!);
      else if (t.kind === "hook") plan = planHook(current);
      else plan = await planSkill(current);
    } catch (e) {
      plan = { outcome: "failed", reason: `could not read (${(e as Error).message})` };
    }

    if (plan.outcome === "connected" && plan.next !== undefined) {
      if (dryRun) {
        io.out(`would write ${t.path}`);
        if (t.kind === "json") io.out(block(t.entry));
        else if (t.kind === "toml") io.out(`[mcp_servers.tocsin]\nurl = "${mcpUrl}"`);
        else if (t.kind === "hook") io.out(hookBlock());
        continue;
      }
      try {
        await atomicWrite(t.path, plan.next);
        io.out(`${t.name}: ${t.kind === "skill-copy" ? "installed" : "connected"} (${t.path})`);
        if (t.flag === "claude-code" && t.kind === "json") claudeCodeWired = true;
      } catch (e) {
        plan = { outcome: "failed", reason: `could not write (${(e as Error).message})` };
      }
    }
    if (plan.outcome === "already") {
      already++;
      if (t.flag === "claude-code" && t.kind === "json") claudeCodeWired = true;
      io.out(`${t.name}: ${t.kind === "skill-copy" ? "already installed" : "already connected"} (${t.path})`);
    }
    if (plan.outcome === "different" && t.kind === "skill-copy") {
      io.out(`${t.name}: ${t.path} differs from ours (edited?), left as is`);
    } else if (plan.outcome === "different" && t.kind === "hook") {
      io.out(`${t.name}: ${t.path} has a different tocsin hook, left as is. Ours is:`);
      io.out(hookBlock());
    } else if (plan.outcome === "different") {
      io.out(`${t.name}: ${t.path} has a different tocsin entry, left as is. Ours is:`);
      io.out(t.kind === "toml" ? `[mcp_servers.tocsin]\nurl = "${mcpUrl}"` : block(t.entry));
    }
    if (plan.outcome === "failed") {
      failed++;
      const isFile = t.kind === "skill" || t.kind === "skill-copy";
      io.out(`${t.name}: ${plan.reason} ${t.path}; add this ${isFile ? "file" : "block"} by hand:`);
      if (t.kind === "json") io.out(block(t.entry));
      else if (t.kind === "toml") io.out(`[mcp_servers.tocsin]\nurl = "${mcpUrl}"`);
      else if (t.kind === "hook") io.out(hookBlock());
      else io.out(`copy skills/${t.src ?? "tocsin/SKILL.md"} from the tocsin package to ${t.path}`);
    }
  }

  if (claudeCodeWired) io.out(`Claude Code plugin (skill, MCP server and session-start check in one): ${PLUGIN_INSTALL_COMMAND}`);
  if (already === chosen.length) io.out("already connected, nothing changed");
  return failed > 0 ? 1 : 0;
}
