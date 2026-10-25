import { test, expect } from "@playwright/test";

test.describe("App shell & sidebar navigation", () => {
  test("sidebar exposes one tab per section", async ({ page }) => {
    await page.goto("/");
    const labels = [
      "Dashboard", "Schedule", "Bulk upload", "Queue", "History",
      "Rotation", "Media", "Channels", "Settings", "Explorer",
    ];
    for (const label of labels) {
      await expect(page.locator(`a.tablink[aria-label="${label}"]`)).toHaveCount(1);
    }
  });

  test("clicking a tab activates it and shows its section (others hidden)", async ({ page }) => {
    await page.goto("/");
    await page.click('a.tablink[aria-label="Explorer"]');
    await expect(page).toHaveURL(/#explorer/);
    await expect(page.locator('a.tablink[aria-label="Explorer"]')).toHaveClass(/active/);
    await expect(page.locator("section#explorer")).toHaveClass(/active/);
    await expect(page.locator("section#desk")).not.toHaveClass(/active/);
  });
});
