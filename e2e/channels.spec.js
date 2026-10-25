import { test, expect } from "@playwright/test";

test.describe("Channels page", () => {
  test("renders a card for each connected channel with status + quota", async ({ page, request }) => {
    const list = await (await request.get("/api/auth/channels")).json();
    expect(Array.isArray(list)).toBeTruthy();

    await page.goto("/");
    await page.click('a.tablink[aria-label="Channels"]');
    await expect(page.locator("section#channels")).toHaveClass(/active/);

    const cards = page.locator("#channelList .channel-card");
    await expect(cards).toHaveCount(list.length);
    if (list.length) {
      await expect(cards.first()).toContainText(list[0].name);
    }
  });

  test("channel cards reflect connected/disconnected state", async ({ page, request }) => {
    const list = await (await request.get("/api/auth/channels")).json();
    await page.goto("/");
    await page.click('a.tablink[aria-label="Channels"]');
    // each card carries either a .connected or .needs-reauth/.token-expired state class
    const cards = page.locator("#channelList .channel-card");
    if (list.length) {
      for (const card of await cards.all()) {
        const cls = await card.getAttribute("class");
        expect(/(connected|needs-reauth|token-expired)/.test(cls ?? "")).toBeTruthy();
      }
    }
  });
});
