import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests for the Video Scheduler web app.
 *
 * Prereqs:
 *   - A running app on http://localhost:3001  (`docker compose up -d`)
 *   - Browsers installed via `npx playwright install`
 *   - `npm install` (to pull `@playwright/test` from devDependencies)
 *
 * Run with:  npx playwright test
 *
 * NOTE: this environment has no browser and Playwright is not installed here,
 * so these specs are WRITTEN, NOT executed, in this env. They use the real
 * element IDs / API shapes from public/index.html + src/routes.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3001",
    trace: "on-first-retry",
    screenshot: "only-as-needed",
    viewport: { width: 1280, height: 800 },
  },
  globalSetup: "./e2e/global-setup.js",
  projects: [
    {
      name: "chromium-auth",
      use: {
        browserName: "chromium",
        storageState: "e2e/storageState.json", // created by global-setup (authed)
      },
    },
  ],
});
