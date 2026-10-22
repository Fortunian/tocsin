import { defineConfig, devices } from "@playwright/test";

// Browser checks for the site pages (TCS-10). Not part of `npm test` or CI:
// run `npx playwright install chromium` once, then `npm run test:e2e`.
const PORT = 8788;

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run migrate:local && npx wrangler dev --port ${PORT}`,
    url: `http://localhost:${PORT}/v1/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
