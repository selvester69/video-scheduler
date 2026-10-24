import { Router } from "express";
import { google } from "googleapis";
import { db } from "../db.js";
import { oauthClientForChannel } from "../services/youtube-auth.js";

const router = Router();
const RANGE_DAYS = new Set([7, 28, 90]);

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function errorReason(error) {
  const status = error?.response?.status || error?.code;
  const message = error?.response?.data?.error?.message || error?.message || "Could not load analytics";
  if (Number(status) === 401 || Number(status) === 403) {
    return "Reconnect this YouTube channel and grant YouTube Analytics read access.";
  }
  if (String(message).toLowerCase().includes("youtube analytics api has not been used") ||
      String(message).toLowerCase().includes("is disabled")) {
    return "Enable the YouTube Analytics API in the Google Cloud project, then retry.";
  }
  return message;
}

router.get("/youtube", async (req, res) => {
  const days = Number(req.query.days || 28);
  if (!RANGE_DAYS.has(days)) return res.status(400).json({ error: "days must be 7, 28, or 90" });

  const requestedChannel = String(req.query.channelId || "");
  const channels = await db.prepare(
    `SELECT id, name, active, access_token, refresh_token, token_expires_at FROM channels WHERE active = 1 ORDER BY name`
  ).all();
  const selected = requestedChannel ? channels.filter((channel) => channel.id === requestedChannel) : channels;
  if (requestedChannel && !selected.length) return res.status(404).json({ error: "YouTube channel not found or inactive" });

  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - 1); // YouTube reports can lag; use the last complete day.
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const startDate = dateString(start);
  const endDate = dateString(end);

  const reports = await Promise.all(selected.map(async (channel) => {
    try {
      const analytics = google.youtubeAnalytics({ version: "v2", auth: oauthClientForChannel(channel) });
      const response = await analytics.reports.query({
        ids: "channel==MINE",
        startDate,
        endDate,
        metrics: "views,comments,likes,subscribersGained,estimatedMinutesWatched",
        dimensions: "day",
        sort: "day",
      });
      const rows = (response.data.rows || []).map((row) => ({
        date: row[0],
        views: Number(row[1] || 0),
        comments: Number(row[2] || 0),
        likes: Number(row[3] || 0),
        subscribers: Number(row[4] || 0),
        watchMinutes: Number(row[5] || 0),
      }));
      return {
        id: channel.id,
        name: channel.name,
        available: true,
        totals: rows.reduce((total, row) => ({
          views: total.views + row.views,
          comments: total.comments + row.comments,
          likes: total.likes + row.likes,
          subscribers: total.subscribers + row.subscribers,
          watchMinutes: total.watchMinutes + row.watchMinutes,
        }), { views: 0, comments: 0, likes: 0, subscribers: 0, watchMinutes: 0 }),
        daily: rows,
      };
    } catch (error) {
      return { id: channel.id, name: channel.name, available: false, error: errorReason(error) };
    }
  }));

  const totals = reports.reduce((total, report) => {
    if (!report.available) return total;
    for (const metric of Object.keys(total)) total[metric] += report.totals[metric];
    return total;
  }, { views: 0, comments: 0, likes: 0, subscribers: 0, watchMinutes: 0 });

  const daily = new Map();
  reports.filter((report) => report.available).forEach((report) => {
    report.daily.forEach((row) => {
      const aggregate = daily.get(row.date) || { date: row.date, views: 0, comments: 0 };
      aggregate.views += row.views;
      aggregate.comments += row.comments;
      daily.set(row.date, aggregate);
    });
  });

  res.json({
    provider: "youtube",
    days,
    startDate,
    endDate,
    totals,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    channels: reports,
    availableChannelCount: reports.filter((report) => report.available).length,
  });
});

export default router;
