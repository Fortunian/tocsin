import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { world } from "./helpers.tcs-33.js";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

const ACTION_YML = fileURLToPath(new URL("../../action/action.yml", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../action/check.mjs", import.meta.url));
const RELEASE_YML = fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url));
const FIXTURE = new URL("../fixtures/cli/package-lock.json", import.meta.url);

// Every input, its documented default and the env name the script reads.
const INPUTS: Record<string, [defaultValue: string, env: string]> = {
  "base-url": ["https://tocsin.sh", "TOCSIN_BASE_URL"],
  "api-key": ["", "TOCSIN_API_KEY"],
  "min-severity": ["low", "TOCSIN_MIN_SEVERITY"],
  "fail-on": ["affected", "TOCSIN_FAIL_ON"],
  "fail-on-error": ["false", "TOCSIN_FAIL_ON_ERROR"],
  comment: ["true", "TOCSIN_COMMENT"],
  "working-directory": [".", "TOCSIN_WORKING_DIRECTORY"],
  "github-token": ["${{ github.token }}", "TOCSIN_GITHUB_TOKEN"],
};

describe("action/action.yml", () => {
  it("is a valid composite action that runs one Node script", async () => {
    const doc = parse(await readFile(ACTION_YML, "utf8"));
    expect(typeof doc.name).toBe("string");
    expect(typeof doc.description).toBe("string");
    expect(doc.description.length).toBeLessThanOrEqual(125);
    expect(doc.branding).toBeTypeOf("object");
    expect(doc.runs.using).toBe("composite");
    expect(Object.keys(doc.inputs).sort()).toEqual(Object.keys(INPUTS).sort());
    for (const [id, [def]] of Object.entries(INPUTS)) {
      expect([id, typeof doc.inputs[id].description]).toEqual([id, "string"]);
      expect([id, doc.inputs[id].required ?? false]).toEqual([id, false]);
      expect([id, String(doc.inputs[id].default)]).toEqual([id, def]);
    }
    expect(doc.outputs.affected).toBeTypeOf("object");

    const steps = doc.runs.steps as { run?: string; shell?: string; uses?: string; env?: Record<string, string> }[];
    expect(steps).toHaveLength(1);
    const [step] = steps;
    expect(step.uses).toBeUndefined();
    expect(step.shell).toBe("bash");
    expect(step.run).toBe('node "${{ github.action_path }}/check.mjs"');
    for (const [id, [, env]] of Object.entries(INPUTS)) expect([env, step.env?.[env]]).toEqual([env, `\${{ inputs.${id} }}`]);
  });

  it("the same check run through `node -e` parses the file", () => {
    const r = spawnSync(
      process.execPath,
      ["-e", `const y=require("yaml");const d=y.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(d.runs.using!=="composite")process.exit(1)`, ACTION_YML],
      { encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("the script is plain JavaScript that Node runs without a build or a package", () => {
    const r = spawnSync(process.execPath, ["--check", SCRIPT], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("release.yml moves the v1 tag on manual dispatch", async () => {
    const doc = parse(await readFile(RELEASE_YML, "utf8"));
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    expect(JSON.stringify(doc)).toContain("v1");
    expect(doc.permissions.contents).toBe("write");
  });
});

describe("the script as a real process", () => {
  it("exits 1 and writes the summary against a local fake API", async () => {
    const w = await world({ event: "push" });
    await copyFile(FIXTURE, join(w.dir, "package-lock.json"));
    const server: Server = createServer((req, res) => {
      let seen = "";
      req.on("data", (c) => (seen += c));
      req.on("end", () => {
        const ok = req.method === "POST" && req.url === "/v1/check" && seen.includes("lodash");
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            ok
              ? {
                  checked: 2,
                  affected: [
                    {
                      dependency: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
                      advisory_id: "tcs_01JA0000000000000000000033",
                      severity: { label: "high" },
                      exploited: false,
                      fixed_in: "4.17.21",
                      action: "Upgrade lodash to 4.17.21 or later.",
                      url: "https://example.com/fixture/lodash",
                    },
                  ],
                  skipped: [],
                  feed_cursor: 3,
                }
              : { error: "not found" },
          ),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const env = { PATH: process.env.PATH ?? "", ...w.env, TOCSIN_BASE_URL: `http://127.0.0.1:${port}` };
      const child = spawn(process.execPath, [SCRIPT], { env });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      const code = await new Promise<number | null>((r) => child.on("close", r));
      expect(out).not.toContain("Error");
      expect(code).toBe(1);
      expect(await w.summary()).toContain("`npm i lodash@4.17.21`");
    } finally {
      server.close();
      await w.cleanup();
    }
  });
});
