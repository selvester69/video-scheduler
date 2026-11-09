import { randomUUID } from "crypto";
import { Router } from "express";
import { db, nowSec } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { youtubeForChannel } from "../services/youtube-auth.js";

const router = Router();
router.use(requireAuth);

const categories = new Set([
  "Hook", "Re-hooks & pacing", "B-roll & editing", "Audio", "Story & clarity", "Call to action", "Other",
]);
const validVideoId = (value) => typeof value === "string" && /^[\w-]{6,160}$/.test(value);

async function getChannel(channelId) {
  if (typeof channelId !== "string" || !channelId) return null;
  return db.prepare("SELECT * FROM channels WHERE id = @id AND active = 1").get({ id: channelId });
}

router.get("/youtube/:videoId/notes", async (req, res) => {
  if (!validVideoId(req.params.videoId)) return res.status(400).json({ error: "Invalid YouTube video ID" });
  try {
    const channel = await getChannel(String(req.query.channelId || ""));
    if (!channel) return res.status(404).json({ error: "Connected YouTube channel not found" });
    const notes = await db.prepare(`SELECT id, channel_id AS channelId, youtube_video_id AS videoId,
        category, timestamp_seconds AS timestampSeconds, note, created_at AS createdAt, updated_at AS updatedAt
      FROM youtube_review_notes
      WHERE channel_id = @channelId AND youtube_video_id = @videoId
      ORDER BY timestamp_seconds ASC, created_at ASC`).all({ channelId: channel.id, videoId: req.params.videoId });
    res.json({ items: notes });
  } catch { res.status(500).json({ error: "Could not load review notes" }); }
});

router.post("/youtube/:videoId/notes", async (req, res) => {
  const { channelId, category, timestampSeconds, note } = req.body || {};
  if (!validVideoId(req.params.videoId)) return res.status(400).json({ error: "Invalid YouTube video ID" });
  if (!categories.has(category)) return res.status(400).json({ error: "Choose a valid review category" });
  const seconds = Number(timestampSeconds);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) return res.status(400).json({ error: "Timestamp must be between 0 and 86400 seconds" });
  if (typeof note !== "string" || !note.trim() || note.trim().length > 3000) return res.status(400).json({ error: "Enter a note of up to 3000 characters" });
  try {
    const channel = await getChannel(channelId);
    if (!channel) return res.status(404).json({ error: "Connected YouTube channel not found" });
    const video = await youtubeForChannel(channel).videos.list({ part: "snippet", id: req.params.videoId });
    if (!video.data.items?.some((item) => item.id === req.params.videoId && item.snippet?.channelId === channel.id)) {
      return res.status(404).json({ error: "Video not found on this connected channel" });
    }
    const now = nowSec();
    const entry = {
      id: randomUUID(), channelId: channel.id, videoId: req.params.videoId,
      category, timestampSeconds: seconds, note: note.trim(), createdAt: now, updatedAt: now,
    };
    await db.prepare(`INSERT INTO youtube_review_notes
      (id, channel_id, youtube_video_id, category, timestamp_seconds, note, created_at, updated_at)
      VALUES (@id, @channelId, @videoId, @category, @timestampSeconds, @note, @createdAt, @updatedAt)`).run(entry);
    res.status(201).json({ item: entry });
  } catch (error) {
    const message = String(error?.message || "YouTube request failed");
    res.status(502).json({ error: /permission|scope|forbidden|not authorized/i.test(message)
      ? `${message} Reauthorize the YouTube channel and grant video access.` : message });
  }
});

router.delete("/youtube/:videoId/notes/:noteId", async (req, res) => {
  if (!validVideoId(req.params.videoId)) return res.status(400).json({ error: "Invalid YouTube video ID" });
  try {
    const channel = await getChannel(String(req.query.channelId || ""));
    if (!channel) return res.status(404).json({ error: "Connected YouTube channel not found" });
    const result = await db.prepare(`DELETE FROM youtube_review_notes
      WHERE id = @id AND channel_id = @channelId AND youtube_video_id = @videoId`).run({
      id: req.params.noteId, channelId: channel.id, videoId: req.params.videoId,
    });
    if (!result.changes) return res.status(404).json({ error: "Review note not found" });
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Could not delete review note" }); }
});

export default router;
