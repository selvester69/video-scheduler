import { test, expect } from "@playwright/test";

const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3001";

test.describe("Database Explorer (read-only)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.click('a.tablink[aria-label="Explorer"]');
    await expect(page.locator("section#explorer")).toHaveClass(/active/);
  });

  test("lists all tables on top and has no raw SQL / SELECT * textarea", async ({ page, request }) => {
    const tbl = await (await request.get("/api/explorer/tables")).json();
    // Top pane: table list (tabs with counts). Bottom pane: viewer.
    await expect(page.locator("#explorerTables button.cc-btn")).toHaveCount(tbl.count);
    await expect(page.locator("#explorerResult")).toBeVisible();
    // The old "run a SELECT *" workflow must not exist.
    await expect(page.locator("#explorerSql, textarea[name='explorerSql'], #runExplorerQuery")).toHaveCount(0);
  });

  test("selecting a table keeps the list on top and renders rows below", async ({ page, request }) => {
    const list = page.locator("#explorerTables");
    await list.locator("button.cc-btn", { hasText: /^users/ }).click();

    // list is never replaced by a breadcrumb — all tabs still present
    const tbl = await (await request.get("/api/explorer/tables")).json();
    await expect(list.locator("button.cc-btn")).toHaveCount(tbl.count);
    // active tab highlighted
    await expect(list.locator("button.cc-btn.cc-btn--active", { hasText: /^users/ })).toHaveCount(1);
    // rows render below in #explorerResult
    const viewer = page.locator("#explorerResult");
    await expect(viewer.locator("table.explorer-table")).toHaveCount(1);
    await expect(viewer.locator("th", { hasText: "email" })).toHaveCount(1);
    await expect(viewer.locator("tbody tr")).not.toHaveCount(0);
  });

  test("GET /api/explorer/tables without auth -> 401", async ({ request }) => {
    const anon = await request.newContext(); // fresh context, no storageState
    const res = await anon.get(`${BASE}/api/explorer/tables`);
    expect(res.status()).toBe(401);
    await anon.dispose();
  });

  test("POST /api/explorer/query rejects non-SELECT (read-only guard)", async ({ request }) => {
    const res = await request.post("/api/explorer/query", { data: { sql: "DROP TABLE users" } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});

test.describe("Explorer read-only guard extras", () => {
  test("unknown table name -> 400", async ({ request }) => {
    const res = await request.get("/api/explorer/table/nope-nope");
    expect(res.status()).toBe(400);
  });

  test("viewer heading reports row count", async ({ page }) => {
    await page.goto("/");
    await page.click('a.tablink[aria-label="Explorer"]');
    await page.locator("#explorerTables button.cc-btn", { hasText: /^users/ }).click();
    await expect(page.locator("#explorerResult .explorer-result-heading")).toContainText(/rows/i);
  });
});
