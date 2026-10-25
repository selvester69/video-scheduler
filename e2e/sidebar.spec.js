import { test, expect } from "@playwright/test";

test.describe("Sidebar collapse + hover-reveals-name (compressed)", () => {
  test("tab labels are visible on a normal-width viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const tab = page.locator('a.tablink[aria-label="Dashboard"]');
    const fs = await tab.evaluate((el) => getComputedStyle(el).fontSize);
    expect(Number(fs)).toBeGreaterThan(0);
  });

  test("at <=500px the sidebar collapses to icons-only (label hidden)", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto("/");
    const tab = page.locator('a.tablink[aria-label="Dashboard"]');
    // compressed mode sets font-size:0 so the text label is hidden
    const fs = await tab.evaluate((el) => getComputedStyle(el).fontSize);
    expect(Number(fs)).toBe(0);
  });

  test("hovering a collapsed tab reveals its name via ::after (aria-label)", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto("/");
    const tab = page.locator('a.tablink[aria-label="Dashboard"]');

    const before = await tab.evaluate((el) => getComputedStyle(el, "::after").visibility);
    expect(before).toBe("hidden");

    await tab.hover();

    const after = await tab.evaluate((el) => getComputedStyle(el, "::after").visibility);
    expect(after).toBe("visible");
    const content = await tab.evaluate((el) => getComputedStyle(el, "::after").content);
    expect(content).toContain("Dashboard");
  });
});


test.describe("Sidebar: all tabs + compressed labels", () => {
  test("all ten section tabs are present", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('nav[aria-label="Main navigation"] a.tablink')).toHaveCount(10);
  });
  test("at <=500px group labels are hidden (compressed mode)", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto("/");
    const group = page.locator(".sidebar-group").first();
    if (await group.count()) await expect(group).toBeHidden();
  });
});

