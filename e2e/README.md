# Playwright E2E for the Video Scheduler

Browser-based end-to-end tests for the scenarios built in the app:
sidebar navigation + hover-reveals-name on collapse, the read-only DB Explorer,
and the Bulk Upload channel/publish-to/privacy dropdowns with multi-channel fan-out.

> ⚠️ This environment has **no browser** and `@playwright/test` is **not installed**,
> so these specs are **written, not executed**, here. They are validated only by
> `node --check` (syntax). Run them yourself:

```bash
npm install              # pulls @playwright/test
npx playwright install   # downloads chromium + deps
docker compose up -d     # app on http://localhost:3001 (api worker postgres)
npx playwright test      # or: npm run test:e2e
npx playwright test --ui # interactive UI mode
```

## Setup
- `global-setup.js` registers a throwaway tester user via `POST /api/auth/register`
  (the live app auto-logs-in on register), so **no admin password is needed**.
  Set `TEST_LOGIN_EMAIL` / `TEST_LOGIN_PASSWORD` to override, or point
  `PLAYWRIGHT_BASE_URL` at a non-default port.
- A real `GET https://...googleusercontent.com/...` OAuth flow is **not** used —
  registration gives a direct JWT session cookie.

## Scope
- `app.spec.js` — sidebar has one tab per section; clicking a tab shows its section.
- `sidebar.spec.js` — labels visible wide; hidden (font-size:0) at ≤500px; hovering
  a collapsed tab reveals its `aria-label` via `::after` (visibility hidden→visible).
- `explorer.spec.js` — 11 tables listed with counts, list stays on top when a table
  is selected, rows render below; no `SELECT *` textarea; `POST /api/explorer/query`
  rejects `DROP` (read-only guard); unauth `/tables` → 401.
- `bulk-upload.spec.js` — the 3 dropdowns exist + are populated; selecting 2 channels
  + 1 video fans out to ≥2 jobs; the privacy dropdown applies to the selected row.

## Shared DB note
The e2e suite runs against the **live** Postgres container and will create real
`pending`/`scheduled` job rows (and a registered `pw-tester-*` user). To keep tests
repeatable, point `PLAYWRIGHT_BASE_URL` at a throwaway dev DB, or clean up
`DELETE FROM jobs WHERE title LIKE 'sample%'` afterwards. These specs are **not**
wired into `npm test` (which stays `node --test tests/*.test.js` = 64/64); use
`npm run test:e2e`.
