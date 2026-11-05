import { Router } from "express";
import { db, queries } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { youtubeForChannel } from "../services/youtube-auth.js";
import { listInstagramPublishedMedia } from "../services/instagram.js";
import { listFacebookPublishedVideos, updateFacebookPublishedVideo } from "../services/facebook.js";

const router = Router();
router.use(requireAuth);

function safeMessage(error) {
  const message = String(error?.message || "Platform request failed");
  if (/insufficient|permission|scope|forbidden|not authorized|(#10|#200)/i.test(message)) {
    return `${message} Reconnect this account and grant the requested permissions.`;
  }
  return message;
}

router.get("/library", async (req, res) => {
  try {
    const platform = String(req.query.platform || "all");
    const destinationId = String(req.query.destinationId || "");
    const cursor = String(req.query.cursor || "");
    const items = [];
    let nextCursor = null;

    if (platform === "all" || platform === "youtube") {
      const channels = (await queries.listActiveChannels.all()).filter((c) => !destinationId || c.id === destinationId);
      for (const channel of channels) {
        const youtube = youtubeForChannel(channel);
        const channelInfo = await youtube.channels.list({ part: "contentDetails", mine: true });
        const playlistId = channelInfo.data.items?.find((item) => item.id === channel.id)?.contentDetails?.relatedPlaylists?.uploads || "";
        if (!playlistId) continue;
        const page = await youtube.playlistItems.list({
          part: "snippet,contentDetails", playlistId, maxResults: 50,
          ...(cursor && channels.length === 1 && platform === "youtube" ? { pageToken: cursor } : {}),
        });
        const ids = (page.data.items || []).map((entry) => entry.contentDetails?.videoId).filter(Boolean);
        const details = ids.length ? await youtube.videos.list({ part: "snippet,status,contentDetails", id: ids.join(",") }) : { data: { items: [] } };
        items.push(...(details.data.items || []).map((video) => ({
          id: video.id, platform: "youtube", destinationId: channel.id, destinationName: channel.name,
          title: video.snippet?.title || "YouTube video", description: video.snippet?.description || "",
          tags: (video.snippet?.tags || []).join(", "), thumbnail: video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.default?.url || "",
          url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
          publishedAt: video.snippet?.publishedAt || null,
        })));
        if (channels.length === 1 && platform === "youtube") nextCursor = page.data.nextPageToken || null;
      }
    }

    if (platform === "all" || platform === "instagram") {
      const accounts = (await db.prepare("SELECT * FROM instagram_accounts WHERE active = 1 ORDER BY username").all())
        .filter((a) => !destinationId || a.id === destinationId);
      for (const account of accounts) {
        const page = await listInstagramPublishedMedia(account, cursor);
        items.push(...page.items);
        if (accounts.length === 1) nextCursor = page.nextCursor;
      }
    }

    if (platform === "all" || platform === "facebook") {
      const pages = (await db.prepare("SELECT * FROM facebook_pages WHERE active = 1 ORDER BY name").all())
        .filter((p) => !destinationId || p.id === destinationId);
      for (const pageAccount of pages) {
        const page = await listFacebookPublishedVideos(pageAccount, cursor);
        items.push(...page.items);
        if (pages.length === 1) nextCursor = page.nextCursor;
      }
    }
    res.json({ items, nextCursor });
  } catch (error) {
    res.status(502).json({ error: safeMessage(error) });
  }
});

router.patch("/library/:platform/:destinationId/:mediaId", async (req, res) => {
  const { platform, destinationId, mediaId } = req.params;
  const { title, description, tags } = req.body || {};
  if (!["youtube", "facebook", "instagram"].includes(platform)) return res.status(400).json({ error: "Unsupported platform" });
  if (!mediaId || mediaId.length > 160 || /[/?#]/.test(mediaId)) return res.status(400).json({ error: "Invalid media ID" });
  if ([title, description, tags].some((value) => value != null && typeof value !== "string")) return res.status(400).json({ error: "Metadata must be text" });
  if (String(title || "").length > 500 || String(description || "").length > 10000 || String(tags || "").length > 5000) {
    return res.status(400).json({ error: "Metadata exceeds the allowed length" });
  }
  try {
    if (platform === "youtube") {
      const channel = await db.prepare("SELECT * FROM channels WHERE id = @id AND active = 1").get({ id: destinationId });
      if (!channel) return res.status(404).json({ error: "Connected YouTube channel not found" });
      const youtube = youtubeForChannel(channel);
      const current = await youtube.videos.list({ part: "snippet", id: mediaId });
      const snippet = current.data.items?.[0]?.snippet;
      if (!snippet) return res.status(404).json({ error: "Video was not found or is not managed by this channel" });
      const updatedSnippet = {
        title: String(title ?? snippet.title).trim(),
        description: String(description ?? snippet.description ?? ""),
        tags: tags == null ? snippet.tags : String(tags).split(",").map((tag) => tag.trim()).filter(Boolean),
        categoryId: snippet.categoryId,
        ...(snippet.defaultLanguage ? { defaultLanguage: snippet.defaultLanguage } : {}),
        ...(snippet.defaultAudioLanguage ? { defaultAudioLanguage: snippet.defaultAudioLanguage } : {}),
      };
      if (!updatedSnippet.title) return res.status(400).json({ error: "Title cannot be empty" });
      await youtube.videos.update({ part: "snippet", requestBody: { id: mediaId, snippet: updatedSnippet } });
    } else if (platform === "facebook") {
      const page = await db.prepare("SELECT * FROM facebook_pages WHERE id = @id AND active = 1").get({ id: destinationId });
      if (!page) return res.status(404).json({ error: "Connected Facebook Page not found" });
      await updateFacebookPublishedVideo(page, mediaId, { title: String(title || ""), description: String(description || "") });
    } else {
      return res.status(409).json({ error: "Instagram does not allow editing a published video's caption through this API. Open the post on Instagram to edit it there." });
    }
    res.json({ success: true, id: mediaId, platform });
  } catch (error) {
    res.status(502).json({ error: safeMessage(error) });
  }
});

export default router;
