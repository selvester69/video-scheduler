/**
 * YouTube upload executor.
 *
 * Performs a single videos.insert call using a channel's OAuth credentials.
 * Returns a result object on success or throws a classified error
 * (see ./errors.js) so the scheduler can decide backoff / retry / fail.
 *
 * In DRY_RUN mode the network call is replaced by a short sleep + log, so the
 * full scheduling + backoff + multi-channel-rotation flow can be exercised
 * without real Google credentials.
 */
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { config } from "../config.js";
import { youtubeForChannel } from "./youtube-auth.js";
import { fromGoogleError, RateLimitError, AuthError, FatalUploadError } from "./errors.js";

/** @returns {{ youtubeId:string, url:string, etag:string|null, quotaCost:number }} */
export async function uploadJob(job, channel) {
  if (config.dryRun) return dryRunUpload(job, channel);

  const youtube = youtubeForChannel(channel);
  const filePath = path.join(config.storageRoot, job.filename);
  if (!fs.existsSync(filePath)) {
    throw new FatalUploadError(`file not found on disk: ${filePath}`);
  }

  const fileSize = fs.statSync(filePath).size;
  const fileStream = fs.createReadStream(filePath);

  // YouTube renders hashtags that appear in the description (above the title).
  const hashtags = (job.hashtags || "")
    .split(/\s+/)
    .filter((h) => h)
    .map((h) => h.replace(/^#/, "#")) // preserve/normalise leading #
    .join(" ");
  const tags = (job.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t);

  const description = [job.description || "", hashtags ? `\n\n${hashtags}` : ""]
    .join("")
    .trim();

  let res;
  try {
    res = await youtube.videos.insert(
      {
        part: "snippet,status",
        requestBody: {
          snippet: {
            title: job.title,
            description,
            tags,
            // categoryId 22 = "People & Blogs"; override via job.category if needed.
            categoryId: job.category || "22",
          },
          status: {
            privacyStatus: job.privacy || "private",
            madeForKids: false,
          },
        },
        media: {
          body: fileStream,
        },
      },
      {
        // Stream upload; onUploadProgress lets us log progress for big files.
        onUploadProgress: (evt) => {
          const pct = Math.round((evt.bytesRead / Math.max(fileSize, 1)) * 100);
          if (pct % 25 === 0) console.log(`[upload] ${job.id} ${channel.name} ${pct}%`);
        },
        timeout: 0, // resumable uploads can exceed the default 1h; don't let http timeout abort us.
      }
    );
  } catch (err) {
    throw fromGoogleError(err);
  }

  const videoId = res.data.id;
  const url = videoId ? `https://youtu.be/${videoId}` : null;
  const etag = res.data.etag || null;
  return { youtubeId: videoId, url, etag, quotaCost: config.quota.uploadCost };
}

/**
 * Simulate an upload for testing the worker without network/credentials.
 * Honours DRY_RUN_FAIL_FIRST_N (e.g. "2" => the first 2 attempts throw a
 * rate-limit, the 3rd succeeds) so backoff + retry + rotation can be exercised
 * deterministically without real Google credentials.
 */
async function dryRunUpload(job, channel) {
  const failFirstN = parseInt(process.env.DRY_RUN_FAIL_FIRST_N || "0", 10);
  const attempt = (job.retry_count || 0) + 1;
  console.log(`[dry-run] [attempt ${attempt}] would upload "${job.title}" via channel ${channel.name}`);

  // Pretend the API call takes a moment.
  await new Promise((r) => setTimeout(r, 300));

  if (failFirstN > 0 && attempt <= failFirstN) {
    console.log("[dry-run] simulating rate-limit-exceeded (429)");
    const ra = parseInt(process.env.DRY_RUN_RETRY_AFTER || "12", 10);
    throw new RateLimitError("simulated 429 quotaExceeded", ra);
  }

  const fakeId = `dryrun_${job.id.slice(0, 8)}${(Math.random() * 1e6) | 0}`;
  return {
    youtubeId: job.youtubeId || fakeId,
    url: `https://youtu.be/${fakeId}?dry-run=1`,
    etag: `etag-dry-${fakeId}`,
    quotaCost: config.quota.uploadCost,
  };
}

export { RateLimitError, AuthError, FatalUploadError } from "./errors.js";
