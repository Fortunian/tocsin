import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Four projects. `api` is the main worker (src/index.ts, D1).
// `mcp` is the MCP worker (workers/mcp), which has no D1 binding.
// `cli` is the npm package in packages/cli; it runs in plain Node.
// `action` is the GitHub Action in action/; it runs in plain Node too.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.toml" },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: "api",
            include: ["tests/**/*.test.ts"],
            exclude: ["tests/mcp/**", "tests/cli/**", "tests/action/**"],
            setupFiles: ["./tests/apply-migrations.ts"],
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./workers/mcp/wrangler.toml" },
              miniflare: { bindings: { TOCSIN_BASE_URL: "https://api-fixture.tocsin.test" } },
            }),
          ],
          test: {
            name: "mcp",
            include: ["tests/mcp/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "cli",
            environment: "node",
            include: ["tests/cli/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "action",
            environment: "node",
            include: ["tests/action/**/*.test.ts"],
          },
        },
      ],
    },
  };
});
