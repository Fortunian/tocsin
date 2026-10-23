import { expect, test } from "@playwright/test";

// /docs shows the Codex section (TCS-28). Standalone: imports nothing from src.
test("/docs shows the Codex heading and the --codex command", async ({ page }) => {
  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "Codex", exact: true })).toBeVisible();
  await expect(page.getByText("npx tocsin connect --codex", { exact: true })).toBeVisible();
});
