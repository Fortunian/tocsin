import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import workflowYml from "../../.github/workflows/backfill.yml?raw";

// .github/workflows/backfill.yml: a manual run per ecosystem that runs the
// import script with the Actions secret TOCSIN_IMPORT_TOKEN.
interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, { type?: string; options?: string[]; default?: string | number; required?: boolean }> } };
  concurrency: { group: string } | string;
  jobs: Record<string, { "timeout-minutes": number; env?: Record<string, string>; steps: { run?: string; env?: Record<string, string> }[] }>;
}

const w = parse(workflowYml) as Workflow;
const job = Object.values(w.jobs)[0];
const runStep = job.steps.find((s) => s.run?.includes("scripts/backfill/run.mjs"));

describe("backfill.yml", () => {
  it("is a workflow_dispatch with an ecosystem choice of the six OSV ecosystems and a batch input", () => {
    const inputs = w.on.workflow_dispatch.inputs;
    expect(inputs.ecosystem.type).toBe("choice");
    expect(inputs.ecosystem.options).toEqual(["npm", "PyPI", "Go", "Packagist", "crates.io", "RubyGems"]);
    expect(String(inputs.batch.default)).toBe("100");
  });

  it("runs scripts/backfill/run.mjs with the secret TOCSIN_IMPORT_TOKEN as IMPORT_TOKEN", () => {
    expect(runStep, "a step that runs scripts/backfill/run.mjs").toBeDefined();
    const env = { ...job.env, ...runStep!.env };
    expect(env.IMPORT_TOKEN).toBe("${{ secrets.TOCSIN_IMPORT_TOKEN }}");
    expect(env.TOCSIN_URL).toContain("https://tocsin.sh");
    // The inputs reach the shell as env values, never as script text.
    expect(env.ECOSYSTEM).toBe("${{ inputs.ecosystem }}");
    expect(env.BATCH).toBe("${{ inputs.batch }}");
    expect(runStep!.run).not.toContain("${{");
  });

  it("never runs two imports of one ecosystem at once and has a 6 h timeout", () => {
    const group = typeof w.concurrency === "string" ? w.concurrency : w.concurrency.group;
    expect(group).toBe("backfill-${{ inputs.ecosystem }}");
    expect(job["timeout-minutes"]).toBe(360);
  });
});
