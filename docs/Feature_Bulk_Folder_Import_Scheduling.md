# Feature: Bulk Folder Import and Rotation Scheduling

## 1. Summary
Watch a local or mounted folder (e.g. a Drive-synced folder) for video files. Queue them automatically, one video per post, and publish them one by one across selected channels — each channel with its own schedule (time, frequency, start date).

## 2. User Flow

1. User adds a **Source Folder** (local path, e.g. `/data/incoming` or a Google Drive desktop sync path).
2. System scans the folder, lists video files found, sorted by file creation time (oldest first) by default.
3. User selects which channels this folder feeds, and sets a schedule **per channel**:
   - Frequency (e.g. every day, every 2 days, specific weekdays)
   - Time of day
   - Start date
   - Optional caption template (e.g. filename as caption, or a fixed template)
4. System builds a queue: each channel gets its own ordered list of videos, assigned to the next available slot per its own schedule.
5. Worker publishes one video per slot, per channel, independently — Channel A and Channel B do not need to post the same video or stay in sync.
6. Published or failed videos are marked so they are not reused. New files dropped into the folder are picked up on the next scan and appended to the end of the queue.

## 3. Key Rule: Independent Per-Channel Pacing

Each channel consumes the shared video pool at its own pace. Example:

| Channel | Frequency | Videos in 5 days |
|---|---|---|
| Channel A | Daily at 9:00 AM | 5 |
| Channel B | Every 2 days at 6:00 PM | 2–3 |

Both channels pull from the same folder, but do not have to post the same video — see Section 5 for pool modes.

## 4. Data Model Additions

```prisma
model SourceFolder {
  id          String   @id @default(cuid())
  path        String   // absolute path, e.g. /data/incoming or mounted drive path
  active      Boolean  @default(true)
  scanInterval Int     @default(300)  // seconds
  lastScanAt  DateTime?
  createdAt   DateTime @default(now())
  items       SourceItem[]
  rules       ChannelRotationRule[]
}

model SourceItem {
  id          String   @id @default(cuid())
  folderId    String
  filename    String
  filePath    String
  sizeBytes   Int
  sha256      String   @unique
  detectedAt  DateTime @default(now())
  status      String   @default("new") // new | queued | used | failed | skipped
  folder      SourceFolder @relation(fields: [folderId], references: [id], onDelete: Cascade)
  assignments RotationAssignment[]
}

model ChannelRotationRule {
  id          String   @id @default(cuid())
  folderId    String
  channelId   String
  frequency   String   // "daily" | "every_n_days" | "weekdays"
  intervalN   Int?     // used when frequency = every_n_days
  weekdays    String?  // CSV of 0-6, used when frequency = weekdays
  timeOfDay   String   // "HH:mm"
  timezone    String   @default("UTC")
  startDate   DateTime
  poolMode    String   @default("shared") // shared | dedicated
  captionTemplate String? // supports {filename}, {index}, {date}
  active      Boolean  @default(true)
  folder      SourceFolder @relation(fields: [folderId], references: [id], onDelete: Cascade)
  assignments RotationAssignment[]
}

model RotationAssignment {
  id          String   @id @default(cuid())
  ruleId      String
  itemId      String
  postId      String?  // link to generated Post once created
  scheduledAt DateTime
  status      String   @default("planned") // planned | scheduled | published | failed | skipped
  rule        ChannelRotationRule  @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  item        SourceItem           @relation(fields: [itemId], references: [id], onDelete: Cascade)

  @@unique([ruleId, itemId])
}
```

## 5. Pool Modes

- **Shared** (default): all channels draw from the same ordered list of videos. Each channel moves through the list independently at its own pace. The same video can go to multiple channels, once each, in each channel's own turn.
- **Dedicated**: the folder is split so each video goes to exactly one channel only, in round-robin order across the active rules. Use this when you don't want the same video posted on more than one channel.

Set per folder or per rule based on what the user picks when adding channels to a folder.

## 6. Scheduling Algorithm (Assignment Planner)

Runs on a timer (e.g. every 5 minutes) and whenever a scan finds new files or a rule changes.

```
for each active ChannelRotationRule:
  compute next unfilled slot time using frequency, timeOfDay, timezone, startDate
    (skip slots that already have a RotationAssignment)
  if poolMode == dedicated:
    candidate = next SourceItem in this folder not yet assigned to ANY rule, status = new
  else: # shared
    candidate = next SourceItem in this folder not yet assigned to THIS rule, status = new or used
  if no candidate -> leave slot unfilled, log "no media available"
  else:
    create RotationAssignment(rule, item, scheduledAt = slot time, status = planned)
    if slot time is within the scheduling horizon (e.g. next 72 hours):
       create the actual Post + PostChannel via existing posting flow
       mark assignment status = scheduled
    mark item.status:
       dedicated -> used
       shared -> used (but still eligible for other rules)
```

Only assignments within a rolling horizon (e.g. next 72 hours) get converted into real scheduled Posts, so edits to a rule do not require rebuilding thousands of future jobs. A background job extends the horizon forward as time passes.

## 7. Folder Scanning: Event-Driven, Not Just Polling

The folder is watched live, so dropping a file in triggers the flow immediately — no waiting for the next poll.

1. **File watcher**: use `chokidar` (Node) on the folder path. It fires an event when a file is created or finishes copying.
2. **Settle check**: cloud-sync tools (Drive, Dropbox) write files in chunks. Before treating a file as "new," wait until its size stops changing — poll the file's size every 2 seconds; once unchanged for 2 consecutive checks, treat it as ready. This avoids importing a half-copied video.
3. On a file becoming ready:
   - Compute SHA-256, create `SourceItem(status = new)`.
   - Immediately trigger the **Assignment Planner** for every active rule on that folder (do not wait for the 5-minute timer).
   - If a channel's rule has an open/unfilled next slot, it gets filled right away with this file; the first scheduled post for it is created instantly.
4. **Polling stays as a safety net**: `scanInterval` (default 5 min) still runs in the background to catch any file the watcher missed (e.g. app was offline when the file was dropped, or watcher restarted). It compares folder contents against known `SourceItem` hashes and imports anything missing.
5. **Auto-activation**: a `ChannelRotationRule` only needs to be created once (Section 6/10). After that, it is always "live" — no manual click needed to resume. The moment a new file lands and a rule has room in its schedule, that rule consumes it on its own. The user does not re-trigger anything.
6. **Watcher lifecycle**: the watcher starts when the app/worker starts, for every `SourceFolder` with `active = true`. If a folder path becomes unreachable (e.g. Drive unmounted), its status shows `unreachable`; the watcher keeps retrying every `scanInterval` until the path returns.

## 8. Important Local-Folder Constraint

If the folder is a cloud-synced path (Google Drive desktop), files can disappear or move before the scheduled time. To avoid broken posts:

- At the moment a `SourceItem` is converted into a real scheduled Post (Section 6, horizon step), **copy the file into the app's own media store** (`./data/media`), the same as a manual upload. Do not publish directly from the watched folder at publish time.
- This makes the schedule reliable even if the source folder changes later, and it reuses all existing Media and publish logic — no changes needed to the worker's publish step.

## 9. Caption Template

`captionTemplate` on each rule supports:
- `{filename}` — file name without extension
- `{index}` — this channel's running count (1, 2, 3, ...)
- `{date}` — the scheduled date

Example: `New drop #{index}: {filename}` → `New drop #4: beach-clip`

If no template is set, the post body is empty (video-only), which is valid for Instagram/Facebook/X but should be flagged in the UI for platforms that require text.

## 10. UI Additions

- **Source Folders page**: add folder path, list detected files with status, manual rescan button.
- **Rotation Rules** (inside folder detail or inside Channel settings): add channel, set frequency/time/timezone/start date/pool mode/caption template.
- **Rotation Queue view**: per channel, shows next N planned videos with their target date, same table style as the existing Queue page, with a `source: folder rotation` tag to distinguish from manually scheduled posts.

## 11. New API Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | /api/folders | Add a source folder |
| GET | /api/folders | List folders and item counts |
| POST | /api/folders/:id/rescan | Trigger manual scan |
| GET | /api/folders/:id/items | List detected files and status |
| POST | /api/folders/:id/rules | Create a channel rotation rule |
| PATCH | /api/rules/:id | Update frequency/time/pool mode/template |
| DELETE | /api/rules/:id | Stop rotation for a channel (keeps already-scheduled posts) |
| GET | /api/rules/:id/assignments | Preview upcoming assignments for a rule |
| GET | /api/rules/:id/slots | Preview upcoming schedule slots (open / assigned) |
| POST | /api/rotation/plan | Run one planning tick (assign next slots + create jobs within 72h) |

## 12. Requirements (FRD additions)

| ID | Requirement | Priority |
|---|---|---|
| FR-ROT-01 | System scans a defined folder for video files on an interval and on demand | Must |
| FR-ROT-02 | User can set an independent schedule (frequency, time, timezone, start date) per channel for a folder | Must |
| FR-ROT-03 | Each channel advances through the video pool at its own pace, unaffected by other channels' schedules | Must |
| FR-ROT-04 | Pool mode can be Shared (reuse across channels) or Dedicated (one video, one channel) | Must |
| FR-ROT-05 | A file is copied into the app's media store before being attached to a scheduled post | Must |
| FR-ROT-06 | Duplicate files (same hash) are not re-imported | Should |
| FR-ROT-07 | If no new video is available for a scheduled slot, the slot is skipped and logged, not left publishing empty | Must |
| FR-ROT-08 | Caption template supports filename, running index, and date placeholders | Should |
| FR-ROT-09 | Stopping a rule does not cancel posts already converted to scheduled | Should |

## 13. Effort Estimate
- Data model and folder scanner: 1.5 days
- Assignment planner (horizon-based): 2 days
- UI (folder page, rule editor, rotation queue view): 2 days
- Integration with existing Post/PostChannel/publish flow: 0.5 day (reuses existing worker unchanged)

Total: about 6 working days, added to Phase 6 or as a Phase 2 item.

## 14. Implementation status & notes

**Implemented (Phase 1)** — `src/db.js`, `src/services/scanner.js`, `src/routes/folders.js`:
- Data model: `source_folders`, `source_items` (app-wide `sha256 UNIQUE` dedup, FR-ROT-06), `rotation_rules`, `rotation_assignments`, `media_assets`. `jobs` gains `source` ('manual'|'rotation') and `media_asset_id`. All migrations are idempotent (`CREATE ... IF NOT EXISTS` + try/caught `ALTER TABLE`).
- Folder scanner `scanFolder()` walks a directory, streams SHA-256 (`crypto.createHash`), upserts `source_items`, and stamps `last_scan_at`. Re-scans dedupe app-wide; a file that re-appears at the same size is "refreshed" in place rather than re-added.
- Manual rescan + CRUD API (auth-gated via `requireAuth`):
  `GET/POST /api/folders`, `POST /api/folders/:id/rescan`, `GET /api/folders/:id/items`, `POST /api/folders/:id/rules`, `PATCH /api/rules/:id`, `DELETE /api/rules/:id`, `GET /api/rules/:id/assignments`, `GET /api/rules/:id/slots`. Validation covers path/existence, channel membership, frequency/time/timezone, and pool mode.

**Implemented (Phase 2)** — `src/services/timezone.js`, `src/services/caption.js`, `src/services/rotation-planner.js`, `src/services/watcher.js`:
- `nextSlots(rule, fromSec, count)` — timezone- + DST-aware slot computation via Node's built-in `Intl` (full-ICU in the linux/arm64 image; no timezone dependency). Frequencies: `daily`, `every_n_days` (intervalN), `weekdays` (Mon=0..Sun=6). Honors `timeOfDay`, `timezone`, and `startDate`.
- `renderCaption(template, {filename,index,date})` — `{filename}` stem, `{index}` running count, `{date}` YYYY-MM-DD (FR-ROT-08).
- `plan({fromSec, horizonHours=72})` — for each active rule: fill its **next unfilled** slot; pick the next eligible item per pool mode (dedicated = never assigned to any rule; shared = not yet assigned to *this* rule, FR-ROT-03/FR-ROT-04); if the slot is within the 72h horizon, copy the file once into `config.storageRoot` (reusing an existing `media_assets` row by sha256 for shared pools — FR-ROT-05), insert a `jobs` row (`source='rotation'`, `media_asset_id`, caption-rendered title — FR-ROT-08) that the existing worker uploads unchanged, and mark the assignment `scheduled`; slots beyond the horizon get a `planned` assignment (no job). **Idempotent** (filled slots are skipped). With no eligible media the slot is skipped + logged (FR-ROT-07). Manual trigger: `POST /api/rotation/plan`.
- `previewSlots(ruleId, {fromSec,count})` — read-only slot preview (`GET /api/rules/:id/slots`) for the Rotation Queue UI.
- `cleanOrphanedMedia()` + `POST /api/rotation/cleanup` — deletes `media_assets` rows (and their `storageRoot` files) that no `jobs` row references; scheduled/pending jobs keep their files. Safe to run anytime.
- `watcher.js` — chokidar watches each active folder (2s de-bounce via `config.watcher.settleMs`), flipping `source_folders.status` to `reachable`/`unreachable` (FR-ROT-07) and skipping unreachable dirs; a polling safety net re-scans every folder on its `scan_interval` (default 300s).
- **Worker integration** (`src/worker.js`): the background worker now runs the planner tick (`config.worker.planIntervalMs`, default 5 min) and the cleanup tick alongside the upload loop, and starts/stops the folder watchers on boot/shutdown.
- **Rotation Queue UI** (`public/index.html`): jobs with `source='rotation'` get a `rotation` tag in the Queue + History tables; the Queue tab shows a live pending-rotation count badge; the Desk dashboard shows a `Rotation` stat card (only active/pending/processing/uploading jobs).
- Tests: `tests/timezone.test.js` (13, incl. DST + tz shift) + 7 planner/watcher/cleanup tests in `tests/folders.test.js` (within-horizon job creation, idempotency, dedicated anti-theft, shared media_asset reuse across channels, slot preview, folder reachability, orphan cleanup keeping referenced assets).

**Deferred:** the Rotation Queue UI is a tag + counters only (no per-rule scheduling editor; rule form already exists). Everything in the Section 13 effort estimate is otherwise implemented.

### Cost & media lifecycle (shared-pool reuse)
- **Re-upload quota cost:** per Section 5, the same video can publish to multiple channels. The worker uploads `jobs.filename` per row (`youtube-upload.js:24`), so every shared-pool publish is a real, separate YouTube upload and **burns that channel's daily quota** (`quota_used`, `QUOTA_BURN_FRACTION`/`quota_used` per channel in `channels`). YouTube does not grant dedup credit across uploads. Dedicated mode (one video → one channel) avoids this. Documented in README; an inline hint in a future rule-editor form is pending (rules are API-formed today).
- **Media-store cleanup:** `media_assets` holds the canonical copy staged into `config.storageRoot` by the planner. A row is eligible for deletion only when **no `jobs.media_asset_id` references it** (`queries.listOrphanedMedia`). For shared pools the file outlives every referencing job until terminal state (done/failed/exhausted/deleted). Phase 2 implements this: `cleanOrphanedMedia()` runs on the worker tick (and via `POST /api/rotation/cleanup`); referenced files are never removed under a pending/scheduled job.
