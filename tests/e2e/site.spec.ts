import { expect, test, type Page } from "@playwright/test";

// The site at desktop and phone widths. Standalone: imports nothing from src.

async function noHorizontalScroll(page: Page): Promise<void> {
  const [scrollWidth, innerWidth] = (await page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")) as [number, number];
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
]) {
  test(`landing renders at ${viewport.width} with no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByText("Security advisories, built for agents.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Latest" })).toBeVisible();
    await noHorizontalScroll(page);
  });
}

test("the copy button next to npx tocsin connect writes it to the clipboard", async ({ page }) => {
  await page.goto("/");
  const button = page.locator('button[data-copy="npx tocsin connect"]');
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveText("Copied");
  expect(await page.evaluate("navigator.clipboard.readText()")).toBe("npx tocsin connect");
});

for (const path of ["/status", "/docs"]) {
  test(`${path} at 375 has no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await noHorizontalScroll(page);
  });
}
