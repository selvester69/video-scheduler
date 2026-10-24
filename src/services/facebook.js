import { config } from "../config.js";
import { queries, nowSec } from "../db.js";
import { AuthError, FatalUploadError, RateLimitError, SchedulerError } from "./errors.js";
import { createSignedMediaUrl } from "./media-url.js";

const GRAPH_ORIGIN = "https://graph.facebook.com";
const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];

function graphUrl(path) {
  return `${GRAPH_ORIGIN}/${config.facebook.graphVersion}/${path}`;
}

function requireCredentials() {
  if (!config.facebook.appId || !config.facebook.appSecret) {
    throw new Error("Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET to enable Facebook Pages publishing.");
  }
}

function readError(body, status) {
  const error = body?.error || body || {};
  const message = error.message || "Facebook Graph API request failed";
  const code = Number(error.code || status);
  if (status === 401 || code === 190 || code === 102) {
    throw new AuthError(`Facebook authorization expired: ${message}`);
  }
  if (status === 429 || status >= 500 || [4, 17, 32, 613].includes(code)) {
    throw new RateLimitError(`Facebook API temporarily unavailable: ${message}`);
  }
  throw new FatalUploadError(`Facebook API rejected the request: ${message}`);
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) readError(body, response.status);
  return body;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  return readJson(response);
}

export function getFacebookAuthUrl(state) {
  requireCredentials();
  const url = new URL(`https://www.facebook.com/${config.facebook.graphVersion}/dialog/oauth`);
  url.searchParams.set("client_id", config.facebook.appId);
  url.searchParams.set("redirect_uri", config.facebook.callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeCode(code) {
  const url = new URL(graphUrl("oauth/access_token"));
  url.searchParams.set("client_id", config.facebook.appId);
  url.searchParams.set("client_secret", config.facebook.appSecret);
  url.searchParams.set("redirect_uri", config.facebook.callbackUrl);
  url.searchParams.set("code", code);
  const shortToken = await getJson(url);
  if (!shortToken.access_token) throw new Error("Facebook did not return an access token.");

  const longUrl = new URL(graphUrl("oauth/access_token"));
  longUrl.searchParams.set("grant_type", "fb_exchange_token");
  longUrl.searchParams.set("client_id", config.facebook.appId);
  longUrl.searchParams.set("client_secret", config.facebook.appSecret);
  longUrl.searchParams.set("fb_exchange_token", shortToken.access_token);
  return getJson(longUrl);
}

async function getManagedPages(userToken) {
  let nextUrl = new URL(graphUrl("me/accounts"));
  nextUrl.searchParams.set("fields", "id,name,access_token");
  nextUrl.searchParams.set("limit", "100");
  nextUrl.searchParams.set("access_token", userToken);
  const pages = [];

  while (nextUrl) {
    const result = await getJson(nextUrl);
    pages.push(...(result.data || []));
    nextUrl = result.paging?.next ? new URL(result.paging.next) : null;
  }
  return pages;
}

export async function connectFacebookPages(code) {
  requireCredentials();
  const token = await exchangeCode(code);
  const userToken = token.access_token;
  const pages = await getManagedPages(userToken);
  const manageablePages = pages.filter((page) => page.id && page.name && page.access_token);
  if (!manageablePages.length) {
    throw new Error("No Facebook Pages were returned. Grant this app access to at least one Page and reconnect.");
  }

  const now = nowSec();
  // Page access tokens returned by /me/accounts are long-lived; mark expiry
  // unknown rather than treating the user's short-lived token lifetime as theirs.
  const expiresAt = null;
  for (const page of manageablePages) {
    await queries.upsertFacebookPage.run({
      id: page.id,
      name: page.name,
      accessToken: page.access_token,
      expiresAt,
      now,
    });
  }
  return manageablePages.map(({ id, name }) => ({ id, name }));
}

export async function publishFacebookVideo(job, page) {
  if (config.dryRun) {
    const videoId = `dryrun_${job.id.slice(0, 8)}`;
    console.log(`[dry-run] would publish Facebook video "${job.title}" to ${page.name}`);
    return { videoId, permalink: `https://www.facebook.com/${encodeURIComponent(page.id)}/videos/${videoId}/` };
  }
  requireCredentials();
  if (!config.facebook.publicAppUrl) {
    throw new FatalUploadError("Set APP_PUBLIC_URL to a public HTTPS URL before publishing Facebook videos.");
  }
  let publicUrl;
  try {
    publicUrl = createSignedMediaUrl(job.filename);
  } catch (error) {
    throw new FatalUploadError(error.message);
  }
  if (publicUrl.protocol !== "https:") {
    throw new FatalUploadError("APP_PUBLIC_URL must use HTTPS for Facebook video publishing.");
  }

  const videoUrl = new URL(graphUrl(`${encodeURIComponent(page.id)}/videos`));
  const response = await fetch(videoUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      file_url: publicUrl.toString(),
      title: job.title || "",
      description: job.description || "",
      access_token: page.access_token,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const result = await readJson(response);
  if (!result.id) throw new SchedulerError("Facebook did not return a video ID.", "transient");
  return {
    videoId: result.id,
    permalink: `https://www.facebook.com/${encodeURIComponent(page.id)}/videos/${encodeURIComponent(result.id)}/`,
  };
}
