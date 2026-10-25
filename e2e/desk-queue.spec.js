import { test, expect } from "@playwright/test";

test.describe("Desk + Queue", () => {
  test("Desk is the default active section on load", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("section#desk")).toHaveClass(/active/);
    await expect(page.locator("section#queue")).not.toHaveClass(/active/);
  });

  test("Queue lists jobs and exposes a status filter", async ({ page, request }) => {
    const jobs = await (await request.get("/api/videos")).json();
    expect(Array.isArray(jobs)).toBeTruthy();

    await page.goto("/");
    await page.click('a.tablink[aria-label="Queue"]');
    await expect(page.locator("section#queue")).toHaveClass(/active/);
    await expect(page.locator("section#queue #jobs")).toBeVisible();
    await expect(page.locator("#queueStatus")).toHaveCount(1);
    // status filter options exist
    for (const v of ["all", "pending", "processing", "uploading"]) {
      await expect(page.locator(`#queueStatus option[value="${v}"]`)).toHaveCount(1);
    }
  });

  test("History section renders and is distinct from Queue", async ({ page }) => {
    await page.goto("/");
    await page.click('a.tablink[aria-label="Queue"]');
    await page.click('a.tablink[aria-label="History"]');
    await expect(page.locator("section#history")).toHaveClass(/active/);
    await expect(page.locator("section#queue")).not.toHaveClass(/active/);
    await expect(page.locator("section#history #historyJobs")).toBeVisible();
  });
});
