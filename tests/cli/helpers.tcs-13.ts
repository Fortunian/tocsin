// A fake Io for the CLI tests: a temp HOME and cwd per test, captured output,
// a fetch that answers only routed URLs and throws on any other, an exec that
// answers only listed commands. No test reaches the network or a real binary.
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, Io } from "../../packages/cli/src/io.js";

export interface FetchCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: RequestInit["body"];
}

export type Route = (call: FetchCall) => Response | Promise<Response> | undefined;

export interface FakeIo extends Io {
  home: string;
  stdout: string[];
  stderr: string[];
  calls: FetchCall[];
  sleeps: number[];
  routes: Route[];
  commands: Map<string, ExecResult | "ENOENT">;
  execCalls: string[];
  text(): { out: string; err: string };
  cleanup(): Promise<void>;
}

export async function fakeIo(argv: string[], env: Record<string, string> = {}): Promise<FakeIo> {
  const home = await mkdtemp(join(tmpdir(), "tocsin-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "tocsin-cwd-"));
  const io: FakeIo = {
    argv,
    env: { HOME: home, ...env },
    cwd,
    platform: "linux",
    home,
    stdout: [],
    stderr: [],
    calls: [],
    sleeps: [],
    routes: [],
    commands: new Map(),
    execCalls: [],
    out(line) {
      io.stdout.push(line);
    },
    err(line) {
      io.stderr.push(line);
    },
    async fetch(url, init) {
      const headers: Record<string, string> = {};
      for (const [k, v] of new Headers(init.headers as ConstructorParameters<typeof Headers>[0])) headers[k.toLowerCase()] = v;
      const call: FetchCall = { url: new URL(url), method: init.method ?? "GET", headers, body: init.body };
      io.calls.push(call);
      for (const route of io.routes) {
        const res = await route(call);
        if (res) return res;
      }
      throw new Error(`fakeIo: unrouted ${call.method} ${url}`);
    },
    async exec(command, args) {
      const key = [command, ...args].join(" ");
      io.execCalls.push(key);
      const r = io.commands.get(key);
      if (r === undefined) throw new Error(`fakeIo: unlisted command ${key}`);
      return r === "ENOENT" ? { code: -1, stdout: "", stderr: "" } : r;
    },
    async sleep(ms) {
      io.sleeps.push(ms);
    },
    text() {
      return { out: io.stdout.join("\n"), err: io.stderr.join("\n") };
    },
    async cleanup() {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    },
  };
  return io;
}

/** Every runtime probe the check verb runs, answered as absent. */
export const ALL_RUNTIMES_ABSENT: [string, "ENOENT"][] = [
  "node --version",
  "php --version",
  "python --version",
  "python3 --version",
  "go version",
  "bun --version",
  "deno --version",
].map((k) => [k, "ENOENT"]);

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** A snapshot of every file under dir: relative path -> bytes and mtime. */
export async function snapshot(dir: string): Promise<Map<string, { bytes: string; mtimeMs: number }>> {
  const out = new Map<string, { bytes: string; mtimeMs: number }>();
  for (const name of await readdir(dir, { recursive: true })) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isFile()) out.set(name, { bytes: (await readFile(p)).toString("base64"), mtimeMs: s.mtimeMs });
    else out.set(name + "/", { bytes: "", mtimeMs: 0 });
  }
  return out;
}

/** The first pretty-printed JSON block in some output: from a line `{` to its line `}`. */
export function firstJsonBlock(text: string): unknown {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "{");
  const end = lines.findIndex((l, i) => i > start && l === "}");
  if (start < 0 || end < 0) throw new Error(`no JSON block in:\n${text}`);
  return JSON.parse(lines.slice(start, end + 1).join("\n"));
}
