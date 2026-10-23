import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { runCheck } from "./check.js";
import { runConnect } from "./connect.js";
import { runLatest, runWatch } from "./feed.js";
import type { ExecResult, Io } from "./io.js";
import { VERSION } from "./version.js";

export type { Io } from "./io.js";

export const USAGE = `Usage: tocsin <command> [flags]

Commands:
  connect   Add the Tocsin MCP server to the agent tools on this machine
            --claude-code --cursor --claude-desktop --codex   wire only these
            --dry-run   print the edits, write nothing
            --print     print the MCP JSON block only
            --hook      also add a Claude Code SessionStart hook that runs the check
            --print-agents-md   print a block for a repo's AGENTS.md, write nothing
  check     Check the lockfiles in this directory and the installed runtimes
            --json      print the result as JSON
            --summary   print one line and exit 0 (for a session hook)
  latest    Print the newest advisories, one per line
            --ecosystem <name>  --since <cursor>  --limit <1-100>  --json
  watch     Print new advisories as they arrive (polls every 5 minutes)
            --ecosystem <name>  --since <cursor>
            --upload   upload the lockfiles here to the key's default watch list and exit

Environment:
  TOCSIN_BASE_URL   API host (default https://tocsin.sh)
  TOCSIN_API_KEY    API key, sent as a Bearer token
  TOCSIN_MCP_URL    MCP server URL for connect (default https://mcp.tocsin.sh/mcp)

Exit codes: 0 ok or clean, 1 affected (check) or a failed edit (connect),
2 usage error, 3 the API call failed.`;

type Options = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

const VERBS: Record<string, { options: Options; run: (io: Io, values: Record<string, unknown>) => Promise<number> }> = {
  connect: {
    options: {
      "claude-code": { type: "boolean" },
      cursor: { type: "boolean" },
      "claude-desktop": { type: "boolean" },
      codex: { type: "boolean" },
      "dry-run": { type: "boolean" },
      print: { type: "boolean" },
      hook: { type: "boolean" },
      "print-agents-md": { type: "boolean" },
    },
    run: runConnect,
  },
  check: { options: { json: { type: "boolean" }, summary: { type: "boolean" } }, run: runCheck },
  latest: {
    options: { ecosystem: { type: "string" }, since: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" } },
    run: runLatest,
  },
  watch: { options: { ecosystem: { type: "string" }, since: { type: "string" }, upload: { type: "boolean" } }, run: runWatch },
};

/** The CLI entry point. Returns the exit code. */
export async function main(io: Io): Promise<number> {
  const [verb, ...rest] = io.argv;
  if (verb === undefined) {
    io.err(USAGE);
    return 2;
  }
  if (verb === "--help" || verb === "-h" || verb === "help") {
    io.out(USAGE);
    return 0;
  }
  if (verb === "--version" || verb === "-v") {
    io.out(VERSION);
    return 0;
  }
  const spec = VERBS[verb];
  if (!spec) {
    io.err(`tocsin: unknown command "${verb}"\n\n${USAGE}`);
    return 2;
  }
  let values: Record<string, unknown>;
  try {
    const parsed = parseArgs({ args: rest, options: { ...spec.options, help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: false });
    values = parsed.values;
  } catch (e) {
    io.err(`tocsin ${verb}: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  return spec.run(io, values);
}

/** The real io: process, global fetch, child_process. The only place the CLI touches them. */
export function nodeIo(): Io {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
    fetch: (url, init) => fetch(url, init),
    exec: (command, args, timeoutMs) =>
      new Promise<ExecResult>((resolve) => {
        execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
