import { Router } from "express";
import { google } from "googleapis";
import { db } from "../db.js";
import { oauthClientForChannel } from "../services/youtube-auth.js";
import { getFacebookVideoInsights } from "../services/facebook.js";

const router = Router();
const RANGE_DAYS = new Set([7, 28, 90]);

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function errorReason(error) {
  const status = error?.response?.status || error?.code;
  const message = error?.response?.data?.error?.message || error?.message || "Could not load analytics";
  if (String(message).toLowerCase().includes("youtube analytics api has not been used") ||
      String(message).toLowerCase().includes("is disabled")) {
    return "Enable the YouTube Analytics API in the Google Cloud project, then retry.";
  }
  if (Number(status) === 401 || Number(status) === 403) {
    return "Reconnect this YouTube channel and grant YouTube Analytics read access.";
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

router.get("/facebook", async (req, res) => {
  const days = Number(req.query.days || 28);
  if (!RANGE_DAYS.has(days)) return res.status(400).json({ error: "days must be 7, 28, or 90" });

  const requestedPageId = String(req.query.pageId || "");
  const pages = await db.prepare(
    `SELECT id, name, access_token FROM facebook_pages WHERE active = 1 ORDER BY name`
  ).all();
  const selectedPages = requestedPageId ? pages.filter((page) => page.id === requestedPageId) : pages;
  if (requestedPageId && !selectedPages.length) {
    return res.status(404).json({ error: "Facebook Page not found or inactive" });
  }

  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const startDate = dateString(start);
  const endDate = dateString(end);
  const since = Math.floor(start.getTime() / 1000);
  const until = Math.floor(end.getTime() / 1000) + 86400;

  const publishedVideos = await db.prepare(
    `SELECT jobs.id AS job_id, jobs.title, facebook_uploads.facebook_video_id AS video_id,
        facebook_uploads.permalink, facebook_uploads.created_at AS published_at,
        jobs.facebook_page_id AS page_id
      FROM jobs
      JOIN facebook_uploads ON facebook_uploads.job_id = jobs.id
      WHERE jobs.platform = 'facebook' AND jobs.status = 'done'
        AND facebook_uploads.created_at >= @since AND facebook_uploads.created_at < @until
        AND jobs.facebook_page_id IS NOT NULL
      ORDER BY facebook_uploads.created_at DESC`
  ).all({ since, until });

  const byPage = new Map(selectedPages.map((page) => [page.id, {
    id: page.id,
    name: page.name,
    available: true,
    videos: [],
    error: null,
  }]));
  const selectedVideos = publishedVideos.filter((video) => byPage.has(video.page_id)).slice(0, 100);

  for (let index = 0; index < selectedVideos.length; index += 5) {
    await Promise.all(selectedVideos.slice(index, index + 5).map(async (video) => {
      const page = selectedPages.find((item) => item.id === video.page_id);
      const report = byPage.get(video.page_id);
      try {
        const views = await getFacebookVideoInsights(video.video_id, page.access_token);
        report.videos.push({
          id: video.job_id,
          title: video.title,
          videoId: video.video_id,
          permalink: video.permalink,
          publishedAt: video.published_at,
          views,
          available: true,
        });
      } catch (error) {
        const permissionError = [10, 200].includes(Number(error.code))
          || /permission|insight|#10\b|#200\b/i.test(error.message || "");
        report.videos.push({
          id: video.job_id,
          title: video.title,
          videoId: video.video_id,
          permalink: video.permalink,
          publishedAt: video.published_at,
          views: null,
          available: false,
          error: permissionError
            ? "Grant the Meta read_insights permission, then reconnect this Facebook Page."
            : error.message,
        });
      }
    }));
  }

  const reports = [...byPage.values()].map((page) => {
    page.videos.sort((a, b) => Number(b.publishedAt) - Number(a.publishedAt));
    const availableVideos = page.videos.filter((video) => video.available);
    const unavailableVideos = page.videos.filter((video) => !video.available);
    return {
      ...page,
      available: page.videos.length === 0 || availableVideos.length > 0,
      totals: {
        videos: page.videos.length,
        views: availableVideos.reduce((sum, video) => sum + video.views, 0),
      },
      partial: unavailableVideos.length > 0 && availableVideos.length > 0,
      errors: unavailableVideos.map((video) => ({ title: video.title, error: video.error })),
    };
  });

  res.json({
    provider: "facebook",
    days,
    startDate,
    endDate,
    metricScope: "Lifetime views for Facebook videos published during the selected date range.",
    totals: reports.reduce((total, page) => {
      if (page.available) {
        total.videos += page.totals.videos;
        total.views += page.totals.views;
      }
      return total;
    }, { videos: 0, views: 0 }),
    pages: reports,
    availablePageCount: reports.filter((page) => page.available).length,
    truncated: publishedVideos.filter((video) => byPage.has(video.page_id)).length > selectedVideos.length,
  });
});

export default router;
