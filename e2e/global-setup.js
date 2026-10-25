import { request } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(__dirname, "storageState.json");
const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3001";

/**
 * Registers a throwaway tester user (auto-logs-in sets the JWT httpOnly cookie)
 * and persists the authenticated session to e2e/storageState.json so the
 * authed projects can run without re-logging-in per test.
 *
 * The live app exposes `POST /api/auth/register` (auto-login), so no admin
 * password is needed — only a running app at PLAYWRIGHT_BASE_URL.
 */
export default async function globalSetup() {
  const email = process.env.TEST_LOGIN_EMAIL || `pw-tester-${Date.now()}@scheduler.local`;
  const password = process.env.TEST_LOGIN_PASSWORD || "Tester123!";
  const name = "Playwright Tester";

  const ctx = await request.newContext();
  try {
    const res = await ctx.post(`${BASE}/api/auth/register`, {
      data: { name, email, password },
      headers: { "content-type": "application/json" },
    });
    if (!res.ok()) {
      console.error(`[playwright] register failed (${res.status()}): ${await res.text()}`);
      return; // storageState stays absent -> authed specs will error with a clear message
    }
    await ctx.storageState({ path: STATE });
    console.log(`[playwright] registered + authed ${email} -> ${STATE}`);
  } catch (err) {
    console.error(`[playwright] cannot reach ${BASE}: ${err.message}`);
  } finally {
    await ctx.dispose();
  }
}
