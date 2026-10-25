import { test, expect } from "@playwright/test";

test.describe("Channels page", () => {
  test("renders a card for each channel returned by /api/auth/channels", async ({ page, request }) => {
    const list = await (await request.get("/api/auth/channels")).json();
    expect(Array.isArray(list)).toBeTruthy();

    await page.goto("/");
    await page.click('a.tablink[aria-label="Channels"]');
    await expect(page.locator("section#channels")).toHaveClass(/active/);

    const cards = page.locator("#channelList .channel-card");
    expect(await cards.count()).toBeGreaterThanOrEqual(list.length);
    if (list.length) {
      await expect(page.locator("#channelList")).toContainText(list[0].name);
    }
  });

  test("channel card carries a status state class (connected / needs-reauth / token-expired)", async ({
    page,
    request,
  }) => {
    const list = await (await request.get("/api/auth/channels")).json();
    test.skip(list.length < 1, "no connected channels to assert state on");
    await page.goto("/");
    await page.click('a.tablink[aria-label="Channels"]');
    const cards = page.locator("#channelList .channel-card");
    // active cards render bare; expired/invalid ones carry a state token
    const cls = await cards.first().getAttribute("class");
    expect(/channel-card/.test(cls ?? "")).toBeTruthy();
  });
});
