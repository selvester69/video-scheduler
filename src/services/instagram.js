import { config } from "../config.js";
import { db, queries, nowSec } from "../db.js";
import { AuthError, FatalUploadError, RateLimitError, SchedulerError } from "./errors.js";
import { createSignedMediaUrl } from "./media-url.js";

const GRAPH_URL = "https://graph.instagram.com";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (response.ok) return body;

  const error = body.error || body;
  const message = error.message || error.error_message || "Instagram API request failed";
  const code = Number(error.code || error.error_subcode || response.status);
  if (response.status === 401 || code === 190) throw new AuthError(`Instagram authorization expired: ${message}`);
  if (response.status === 429 || response.status >= 500) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new RateLimitError(`Instagram API temporarily unavailable: ${message}`, retryAfter || null);
  }
  throw new FatalUploadError(`Instagram API rejected the request: ${message}`);
}

function requireCredentials() {
  if (!config.instagram.appId || !config.instagram.appSecret) {
    throw new Error("Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET to enable Instagram Reels.");
  }
}

export function getInstagramAuthUrl(state) {
  requireCredentials();
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", config.instagram.appId);
  url.searchParams.set("redirect_uri", config.instagram.callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  return readJson(response);
}

export async function connectInstagramAccount(code) {
  requireCredentials();
  const form = new FormData();
  form.set("client_id", config.instagram.appId);
  form.set("client_secret", config.instagram.appSecret);
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", config.instagram.callbackUrl);
  form.set("code", code.replace(/#_$/, ""));

  const shortTokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const shortTokenBody = await readJson(shortTokenResponse);
  const shortToken = shortTokenBody.data?.[0] || shortTokenBody;
  if (!shortToken.access_token || !shortToken.user_id) {
    throw new Error("Instagram did not return an account token and user ID.");
  }

  const longUrl = new URL(`${GRAPH_URL}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange");
  longUrl.searchParams.set("client_secret", config.instagram.appSecret);
  longUrl.searchParams.set("access_token", shortToken.access_token);
  const longToken = await tokenRequest(longUrl);
  const accessToken = longToken.access_token;
  if (!accessToken) throw new Error("Instagram did not return a long-lived account token.");

  const profileUrl = new URL(`${GRAPH_URL}/me`);
  profileUrl.searchParams.set("fields", "user_id,username");
  profileUrl.searchParams.set("access_token", accessToken);
  const profile = await tokenRequest(profileUrl);
  const id = profile.user_id || profile.id || shortToken.user_id;
  if (!id || !profile.username) throw new Error("Instagram account profile could not be read.");

  const now = nowSec();
  await db.prepare(
    `INSERT INTO instagram_accounts (id, username, access_token, token_expires_at, active, created_at, updated_at)
     VALUES (@id, @username, @accessToken, @expiresAt, 1, @now, @now)
     ON CONFLICT(id) DO UPDATE SET username = excluded.username,
       access_token = excluded.access_token, token_expires_at = excluded.token_expires_at,
       active = 1, updated_at = excluded.updated_at`
  ).run({
    id,
    username: profile.username,
    accessToken,
    expiresAt: now + Number(longToken.expires_in || 5184000),
    now,
  });
  return { id, username: profile.username };
}

async function validAccessToken(account) {
  if (account.token_expires_at - nowSec() > 7 * 86400) return account.access_token;
  const url = new URL(`${GRAPH_URL}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", account.access_token);
  const refreshed = await tokenRequest(url);
  if (!refreshed.access_token) throw new AuthError("Instagram token refresh did not return an access token.");
  const expiresAt = nowSec() + Number(refreshed.expires_in || 5184000);
  await queries.saveInstagramToken.run({
    id: account.id,
    accessToken: refreshed.access_token,
    expiresAt,
    updatedAt: nowSec(),
  });
  return refreshed.access_token;
}

async function graphPost(url, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30000),
  });
  return readJson(response);
}

export async function publishReel(job, account) {
  requireCredentials();
  if (!config.instagram.publicAppUrl) {
    throw new FatalUploadError("Set APP_PUBLIC_URL to the public HTTPS URL serving staged media before publishing Reels.");
  }
  let publicUrl;
  try {
    publicUrl = createSignedMediaUrl(job.filename);
  } catch {
    throw new FatalUploadError("APP_PUBLIC_URL must be a valid public HTTPS URL.");
  }
  if (publicUrl.protocol !== "https:") {
    throw new FatalUploadError("APP_PUBLIC_URL must use HTTPS for Instagram media publishing.");
  }

  const accessToken = await validAccessToken(account);
  const container = await graphPost(`${GRAPH_URL}/${encodeURIComponent(account.id)}/media`, {
    video_url: publicUrl.toString(),
    media_type: "REELS",
    caption: job.title || "",
    share_to_feed: "true",
    access_token: accessToken,
  });
  if (!container.id) throw new SchedulerError("Instagram did not return a Reel media container ID.", "transient");

  const statusUrl = new URL(`${GRAPH_URL}/${encodeURIComponent(container.id)}`);
  statusUrl.searchParams.set("fields", "status_code,status");
  statusUrl.searchParams.set("access_token", accessToken);
  const deadline = Date.now() + 5 * 60 * 1000;
  let state;
  do {
    const status = await tokenRequest(statusUrl);
    state = status.status_code;
    if (state === "FINISHED" || state === "PUBLISHED") break;
    if (state === "ERROR" || state === "EXPIRED") {
      throw new FatalUploadError(`Instagram Reel processing ${state.toLowerCase()}: ${status.status || "media could not be processed"}`);
    }
    if (Date.now() >= deadline) {
      throw new SchedulerError("Instagram Reel processing timed out; it can be retried from the queue.", "transient");
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } while (true);

  const published = await graphPost(`${GRAPH_URL}/${encodeURIComponent(account.id)}/media_publish`, {
    creation_id: container.id,
    access_token: accessToken,
  });
  if (!published.id) throw new SchedulerError("Instagram did not confirm the published Reel.", "transient");

  const permalinkUrl = new URL(`${GRAPH_URL}/${encodeURIComponent(published.id)}`);
  permalinkUrl.searchParams.set("fields", "permalink");
  permalinkUrl.searchParams.set("access_token", accessToken);
  const media = await tokenRequest(permalinkUrl);
  return { mediaId: published.id, permalink: media.permalink || null };
}
