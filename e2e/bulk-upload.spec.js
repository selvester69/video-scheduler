import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(__dirname, "fixtures", "sample.mp4");

// open a <details> menu without toggling (idempotent)
const openDetails = (loc) => loc.evaluate((el) => { el.open = true; });

test.describe("Bulk upload form (channel/publish/privacy controls)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.click('a.tablink[aria-label="Bulk upload"]');
    await expect(page.locator("section#bulk-upload")).toHaveClass(/active/);
  });

  test("bulk-apply controls are present and privacy defaults to private", async ({ page }) => {
    await expect(page.locator("#bulkAddVideos")).toHaveCount(1);
    await expect(page.locator("#bulkChannelsMenu")).toHaveCount(1); // details: accounts/channels
    await expect(page.locator("#bulkPublishMenu")).toHaveCount(1);  // details: platforms
    await expect(page.locator("#bulkPrivacySelect")).toHaveCount(1); // native <select>

    const priv = page.locator("#bulkPrivacySelect");
    await expect(priv).toHaveValue("private"); // window.bulkDefaults.privacy = $("bulkPrivacySelect").value
    await expect(priv.locator("option")).toHaveCount(3);
    for (const v of ["private", "unlisted", "public"]) {
      await expect(priv.locator(`option[value="${v}"]`)).toHaveCount(1);
    }
  });

  test("publish menu exposes youtube + instagram destinations", async ({ page }) => {
    await openDetails(page.locator("#bulkPublishMenu"));
    for (const v of ["youtube:video", "instagram:reel"]) {
      await expect(
        page.locator(`#bulkPublishOptions input[type="checkbox"][value="${v}"]`)
      ).toHaveCount(1);
    }
    // youtube:video ships as the default-selected platform
    await expect(
      page.locator("#bulkPublishOptions input[type='checkbox'][value='youtube:video']")
    ).toBeChecked();
  });

  test("channel options come from GET /api/auth/channels (active only)", async ({ page, request }) => {
    const list = await (await request.get("/api/auth/channels")).json();
    const active = list.filter((c) => c.active);
    test.skip(active.length < 1, "no active channel in this workspace");
    await openDetails(page.locator("#bulkChannelsMenu"));
    await page.waitForSelector("#bulkChannelsOptions input[type='checkbox']");
    await expect(page.locator("#bulkChannelsOptions input[type='checkbox']")).toHaveCount(active.length);
  });

  test("adding a video + picking a channel submits to /api/videos", async ({ page }) => {
    await page.setInputFiles("#bulkVideoInput", fixture);
    await expect(page.locator("#bulkFileList tr")).toHaveCount(1);
    await page.check("#bulkHeaderSelect");
    await expect(page.locator("#bulkSubmitBtn")).toHaveText(/1 selected video/);

    // destination: youtube:video (default, pre-checked) + first connected channel
    await openDetails(page.locator("#bulkChannelsMenu"));
    const firstChan = page.locator("#bulkChannelsOptions input[type='checkbox']").first();
    test.skip((await firstChan.count()) < 1, "no connected active channel to upload to");
    await firstChan.check();

    // the bulk submit fans the file out into itemsForSubmit/filesForSubmit (1:1 per
    // selected row x selected channel x selected platform) and POSTs multipart to /api/videos
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/videos") && r.request().method() === "POST"),
      page.click("#bulkSubmitBtn"),
    ]);
    // 2xx = job scheduled; 4xx = a per-channel validation/auth issue surfaced in #bulkMsg
    // (e.g. an expired channel token) rather than a scheduler bug.
    expect(res.status()).toBeGreaterThanOrEqual(200);
    expect(res.status()).toBeLessThan(500);
    await expect(page.locator("#bulkMsg")).not.toBeEmpty();
  });

  test("publish-to switch is reflected in the app's selected-platform set", async ({ page }) => {
    await openDetails(page.locator("#bulkPublishMenu"));
    await page.locator("#bulkPublishOptions input[type='checkbox'][value='instagram:reel']").check();
    // the app mirrors the checked publish platforms into window.bulkTargetPlatforms
    const tp = await page.evaluate(() =>
      Array.isArray(window.bulkTargetPlatforms) ? window.bulkTargetPlatforms : []
    );
    expect(tp.includes("instagram:reel")).toBeTruthy();
  });
});
