// `tocsin connect`: add the Tocsin MCP server to each agent tool on this
// machine. It reads each config file, edits one key, and writes it back
// through a temp file and a rename. It never writes a file it cannot parse,
// never replaces a user's own `tocsin` entry, and never writes the API key.
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Io } from "./io.js";
import { PKG_ROOT } from "./version.js";

export const DEFAULT_MCP_URL = "https://mcp.tocsin.sh/mcp";

type Kind = "json" | "toml" | "skill";

interface Target {
  name: string;
  flag: string;
  kind: Kind;
  /** The config file. Null when this machine has no path for the target. */
  path: string | null;
  detected: boolean;
  entry?: unknown;
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

function homeDir(io: Io): string | null {
  return (io.platform === "win32" ? io.env.USERPROFILE || io.env.HOME : io.env.HOME || io.env.USERPROFILE) || null;
}

/** The packaged SKILL.md: inside the published package, else in the repo checkout. */
export function skillSource(): { path: string; found: boolean } {
  const published = fileURLToPath(new URL("skills/tocsin/SKILL.md", PKG_ROOT));
  if (existsSync(published)) return { path: published, found: true };
  const repo = fileURLToPath(new URL("../../skills/tocsin/SKILL.md", PKG_ROOT));
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
    { name: "Claude Code", flag: "claude-code", kind: "json", path: claudeJson, detected: claudeDetected, entry: { type: "http", url: mcpUrl } },
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
  const generic = { type: "http", url: mcpUrl };

  if (values.print) {
    io.out(block(generic));
    return 0;
  }

  const home = homeDir(io);
  if (!home) {
    io.err("tocsin connect: HOME is not set");
    return 2;
  }

  const all = targets(io, home, mcpUrl);
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
      plan = t.kind === "json" ? planJson(current, t.entry) : t.kind === "toml" ? planToml(current, mcpUrl) : await planSkill(current);
    } catch (e) {
      plan = { outcome: "failed", reason: `could not read (${(e as Error).message})` };
    }

    if (plan.outcome === "connected" && plan.next !== undefined) {
      if (dryRun) {
        io.out(`would write ${t.path}`);
        if (t.kind === "json") io.out(block(t.entry));
        else if (t.kind === "toml") io.out(`[mcp_servers.tocsin]\nurl = "${mcpUrl}"`);
        continue;
      }
      try {
        await atomicWrite(t.path, plan.next);
        io.out(`${t.name}: connected (${t.path})`);
      } catch (e) {
        plan = { outcome: "failed", reason: `could not write (${(e as Error).message})` };
      }
    }
    if (plan.outcome === "already") {
      already++;
      io.out(`${t.name}: already connected (${t.path})`);
    }
    if (plan.outcome === "different") {
      io.out(`${t.name}: ${t.path} has a different tocsin entry, left as is. Ours is:`);
      io.out(t.kind === "toml" ? `[mcp_servers.tocsin]\nurl = "${mcpUrl}"` : block(t.entry));
    }
    if (plan.outcome === "failed") {
      failed++;
      io.out(`${t.name}: ${plan.reason} ${t.path}; add this ${t.kind === "skill" ? "file" : "block"} by hand:`);
      if (t.kind === "json") io.out(block(t.entry));
      else if (t.kind === "toml") io.out(`[mcp_servers.tocsin]\nurl = "${mcpUrl}"`);
      else io.out(`copy skills/tocsin/SKILL.md from the tocsin package to ${t.path}`);
    }
  }

  if (already === chosen.length) io.out("already connected, nothing changed");
  return failed > 0 ? 1 : 0;
}
