// scripts/validate-plugin.sh: with no claude CLI it skips with a reason and
// exits 0; with a claude CLI it runs both strict validations, prints their
// output and exits non-zero when one fails. The real claude binary is never
// called: the tests put a stub, or nothing, on PATH.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/validate-plugin.sh");

/** Find a tool on the current PATH, by its real file. */
function which(name: string): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = join(d, name);
    if (d && existsSync(p)) return p;
  }
  throw new Error(`${name} not on PATH`);
}

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/** A temp root (plugin + marketplace copy) and a bin dir with only bash, env and coreutils: no claude. */
function setup(): { root: string; bin: string; log: string } {
  tmp = mkdtempSync(join(tmpdir(), "tocsin-validate-plugin-"));
  const root = join(tmp, "root");
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  cpSync(join(ROOT, "plugins"), join(root, "plugins"), { recursive: true });
  cpSync(join(ROOT, ".claude-plugin"), join(root, ".claude-plugin"), { recursive: true });
  for (const t of ["bash", "env", "cat", "dirname"]) symlinkSync(which(t), join(bin, t));
  return { root, bin, log: join(tmp, "claude-args.log") };
}

function stubClaude(bin: string, log: string, rc: number): void {
  const p = join(bin, "claude");
  writeFileSync(p, `#!${which("bash")}\necho "$*" >> "${log}"\necho "stub-claude: $* rc=${rc}"\nexit ${rc}\n`);
  chmodSync(p, 0o755);
}

const run = (bin: string, root: string) =>
  spawnSync(which("bash"), [SCRIPT, "--root", root], { encoding: "utf8", env: { PATH: bin } });

describe("validate-plugin.sh", () => {
  it("no claude CLI: prints the skip reason and exits 0", () => {
    const { root, bin } = setup();
    const r = run(bin, root);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("validate-plugin: skip: the claude CLI is not on this runner");
    expect(r.status).toBe(0);
  });

  it("claude CLI passes: runs both strict validations from the root, prints their output, exits 0", () => {
    const { root, bin, log } = setup();
    stubClaude(bin, log, 0);
    const r = run(bin, root);
    expect(r.status).toBe(0);
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
      "plugin validate --strict ./plugins/tocsin",
      "plugin validate --strict .",
    ]);
    expect(r.stdout).toContain("stub-claude: plugin validate --strict ./plugins/tocsin rc=0");
    expect(r.stdout).toContain("stub-claude: plugin validate --strict . rc=0");
    expect(r.stdout).not.toContain("skip");
  });

  it("claude CLI fails: exits non-zero and never prints a skip", () => {
    const { root, bin, log } = setup();
    stubClaude(bin, log, 1);
    const r = run(bin, root);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain("skip");
    expect(r.stdout).toContain("stub-claude: plugin validate --strict ./plugins/tocsin rc=1");
  });
});
