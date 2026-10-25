import { test, expect } from "@playwright/test";

test.describe("Auth state + theme toggle", () => {
  test("authed /api/auth/profile returns the signed-in user", async ({ request }) => {
    const res = await request.get("/api/auth/profile");
    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(j.email).toBeTruthy();
    expect(j.name).toBeTruthy();
  });

  test("invalid login credentials -> 401", async ({ request }) => {
    const res = await request.post("/api/auth/login", {
      data: { email: "nobody@nowhere.local", password: "wrong-password" },
      headers: { "content-type": "application/json" },
    });
    expect(res.status()).toBe(401);
  });

  test("theme toggle adds/removes dark mode and persists to localStorage", async ({ page }) => {
    await page.goto("/");
    const btn = page.locator("#themeToggle");
    await expect(btn).toHaveCount(1);

    // toggle ON -> dark
    await btn.click();
    await expect(page.evaluate(() => document.documentElement.classList.contains("dark"))).toBeTruthy();
    await expect(page.evaluate(() => localStorage.getItem("movietrendz-theme"))).toBe("dark");

    // toggle OFF -> light
    await btn.click();
    await expect(page.evaluate(() => document.documentElement.classList.contains("dark"))).toBeFalsy();
    await expect(page.evaluate(() => localStorage.getItem("movietrendz-theme"))).toBe("light");
  });
});
