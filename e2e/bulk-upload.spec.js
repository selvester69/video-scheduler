import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(__dirname, "fixtures", "sample.mp4");

test.describe("Bulk upload dropdowns (channels × publish-to × privacy)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.click('a.tablink[aria-label="Bulk upload"]');
    await expect(page.locator("section#bulk-upload")).toHaveClass(/active/);
  });

  test("the three bulk-apply dropdowns exist right after 'Add videos'", async ({ page, request }) => {
    // they sit next to the Add videos button in .bulk-upload-tools
    const addBtn = page.locator("#bulkAddVideos");
    await expect(addBtn).toHaveCount(1);
    await expect(page.locator("#bulkChannelsSelect")).toHaveCount(1); // multi-select channels
    await expect(page.locator("#bulkPublishToSelect")).toHaveCount(1);  // publish to
    await expect(page.locator("#bulkPrivacySelect")).toHaveCount(1);    // youtube privacy

    // channels populated from /api/auth/channels (active ones only)
    const list = await (await request.get("/api/auth/channels")).json();
    const active = list.filter((c) => c.active);
    await expect(page.locator("#bulkChannelsSelect option")).toHaveCount(active.length);

    // publish-to options
    for (const v of ["youtube:video", "instagram:reel"]) {
      await expect(page.locator(`#bulkPublishToSelect option[value="${v}"]`)).toHaveCount(1);
    }
    // youtube privacy options
    for (const v of ["private", "unlisted", "public"]) {
      await expect(page.locator(`#bulkPrivacySelect option[value="${v}"]`)).toHaveCount(1);
    }
  });

  test("multi-select channels fans out one job per video x channel", async ({ page, request }) => {
    const options = page.locator("#bulkChannelsSelect option");
    const n = await options.count();
    test.skip(n < 2, "needs >=2 connected channels to verify multi-channel fan-out");

    await page.locator("#bulkChannelsSelect").selectOptions({ selected: true }, [
      await options.nth(0).getAttribute("value"),
      await options.nth(1).getAttribute("value"),
    ]);

    const before = (await (await request.get("/api/videos")).json()).length;

    // stage a (tiny) video file -> a row is auto-added & auto-selected
    await page.setInputFiles("#bulkVideoInput", fixture);
    await page.click("#bulkSubmitBtn");

    // submit completes and the success banner appears
    await expect(page.locator("#bulkMsg")).not.toBeEmpty();
    // fan-out: 1 video x 2 channels => >=2 new jobs
    const after = (await (await request.get("/api/videos")).json()).length;
    expect(after).toBeGreaterThanOrEqual(before + 2);
  });

  test("privacy dropdown applies to the selected row", async ({ page }) => {
    await page.setInputFiles("#bulkVideoInput", fixture);
    // select-all header checkbox
    await page.check("#bulkHeaderSelect");
    await page.selectOption("#bulkPrivacySelect", "public");

    // the selected row's own per-row privacy <select> should now be "public"
    const row = page.locator("#bulkFileList tr").first();
    const privacySelect = row.locator("select").filter({
      has: page.locator("option[value='public']"),
    });
    await expect(privacySelect).toHaveValue("public");
  });
});


test.describe("Bulk upload dropdown extras", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.click('a.tablink[aria-label="Bulk upload"]');
    await expect(page.locator("section#bulk-upload")).toHaveClass(/active/);
  });
  test("channels dropdown is a native multi-select", async ({ page }) => {
    await expect(page.locator("#bulkChannelsSelect")).toHaveAttribute("multiple");
  });
  test("new video row inherits the global privacy default (private)", async ({ page }) => {
    await page.setInputFiles("#bulkVideoInput", fixture);
    const row = page.locator("#bulkFileList tr").first();
    const privacySelect = row.locator("select").filter({ has: page.locator("option[value='private']") });
    await expect(privacySelect).toHaveValue("private");
  });
});

