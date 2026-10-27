import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Seven projects. `api` is the main worker (src/index.ts, D1).
// `mcp` is the MCP worker (workers/mcp), which has no D1 binding.
// `cli` is the npm package in packages/cli; it runs in plain Node.
// `action` is the GitHub Action in action/; it runs in plain Node too.
// `plugin` checks the Claude Code plugin (plugins/tocsin) and its marketplace.
// `launch` runs scripts/launch-check.sh in Node against the worker in Miniflare.
// `contract` calls real vendors (mail). It is not in `npm test` (an explicit
// project list); `npm run test:contract` runs it with TOCSIN_CONTRACT=1.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.toml" },
              // MAIL_TRANSPORT=fake: the mail seam answers the KV fake, 0 network calls.
              // WEBHOOK_KEK: a test-only fixture key (32 bytes as base64), never a production key.
              // GITHUB_OIDC_TRANSPORT=fake: the OIDC seam never fetches GitHub; tests seed the JWKS in KV.
              // SOCIAL_TRANSPORT=fake: the X seam answers the KV fake, 0 network calls (TCS-106).
              miniflare: {
                bindings: { TEST_MIGRATIONS: migrations, MAIL_TRANSPORT: "fake", WEBHOOK_KEK: "fixturefixturefixturefixturefixturefixture0=", GITHUB_OIDC_TRANSPORT: "fake", SOCIAL_TRANSPORT: "fake" },
              },
            }),
          ],
          test: {
            name: "api",
            include: ["tests/**/*.test.ts"],
            exclude: ["tests/mcp/**", "tests/cli/**", "tests/action/**", "tests/launch/**", "tests/docs/**", "tests/contract/**", "tests/plugin/**"],
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
          // `docs` runs documented code blocks (docs/API.md) in plain Node.
          test: {
            name: "docs",
            environment: "node",
            include: ["tests/docs/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "plugin",
            environment: "node",
            include: ["tests/plugin/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "action",
            environment: "node",
            include: ["tests/action/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "launch",
            environment: "node",
            include: ["tests/launch/**/*.test.ts"],
            testTimeout: 120_000,
            hookTimeout: 180_000,
          },
        },
        {
          // Real-vendor contract tests, off the PR path: they skip without the
          // vendor secret. .github/workflows/mail-contract.yml and social-contract.yml run them.
          test: {
            name: "contract",
            environment: "node",
            include: ["tests/contract/**/*.test.ts"],
            fileParallelism: false,
          },
        },
      ],
    },
  };
});
