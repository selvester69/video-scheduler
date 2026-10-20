/**
 * YouTube OAuth2 management.
 *
 * Each "channel" in the DB corresponds to one authenticated YouTube channel
 * (i.e. one Google account signed into YouTube). The google_client_id /
 * client_secret are shared across channels (they belong to your GCP project)
 * but every channel carries its own long-lived refresh_token.
 *
 * OAuth flow:
 *   GET  /auth               -> redirect user to Google consent screen
 *   GET  /auth/callback      -> Google redirects here with `code`;
 *                                we exchange it for tokens, discover the
 *                                channel (youtube.channels.list mine=true),
 *                                and persist a `channels` row.
 */
import { google } from "googleapis";
import { config } from "../config.js";
import { db, queries, nowSec } from "../db.js";

export function makeOauthClient() {
  const { OAuth2 } = google.auth;
  return new OAuth2({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.callbackUrl,
  });
}

/** URL the user is redirected to for consent. Includes offline access
 *  so we receive a refresh_token (required for unattended scheduling). */
export function getAuthUrl() {
  const client = makeOauthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force refresh_token issuance on every flow
    scope: config.google.scopes,
  });
}

/** Exchange an authorization code for tokens, then look up the YouTube
 *  channel it belongs to. Returns the persisted channel record. */
export async function handleCallback(code) {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured");
  }
  const client = makeOauthClient();
  const { tokens } = await client.getToken(code);

  // Attach tokens so the same client can make the "who am I" call.
  client.setCredentials(tokens);

  // Discover which channel this account maps to.
  const youtube = google.youtube({ version: "v3", auth: client });
  const res = await youtube.channels.list({ part: "id,snippet", mine: true });
  const ch = res.data.items?.[0];
  if (!ch) throw new Error("OAuth succeeded but no YouTube channel is linked to this account");

  const now = nowSec();
  const quotaReset = now + 86400; // daily quota resets ~24h later; refined per channel usage.
  const record = {
    id: ch.id,
    name: ch.snippet?.title || ch.id,
    google_client_id: config.google.clientId,
    google_client_secret: config.google.clientSecret,
    refresh_token: tokens.refresh_token || "",
    access_token: tokens.access_token || "",
    token_expires_at: tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : now + 3600,
    quota_reset_at: quotaReset,
    quota_used: 0,
    last_used_at: now,
    active: 1,
  };

  const persisted = await db.prepare(
    `INSERT INTO channels (id, name, google_client_id, google_client_secret,
       access_token, refresh_token, token_expires_at, quota_reset_at, quota_used, last_used_at, active)
     VALUES (@id, @name, @google_client_id, @google_client_secret, @access_token, @refresh_token,
             @token_expires_at, @quota_reset_at, @quota_used, @last_used_at, @active)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       token_expires_at = excluded.token_expires_at
     RETURNING *`
  ).get(record);

  return persisted;
}

/**
 * Build an authenticated youtube.v3 client for a stored channel row.
 * The OAuth2Client transparently refreshes access tokens using the stored
 * refresh_token when they expire.
 */
export function youtubeForChannel(channel) {
  const client = makeOauthClient();
  client.setCredentials({
    access_token: channel.access_token,
    refresh_token: channel.refresh_token,
    token_expiry_date: channel.token_expires_at ? new Date(channel.token_expires_at * 1000) : undefined,
  });
  // Persist refreshed tokens back to the DB whenever googleapis refreshes them.
  client.on("tokens", (tokens) => {
    void db.prepare(
      `UPDATE channels SET access_token = @accessToken,
           refresh_token = COALESCE(@refreshToken, refresh_token),
           token_expires_at = @expiresAt
       WHERE id = @id`
    ).run({
      id: channel.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : nowSec() + 3600,
    });
  });
  return google.youtube({ version: "v3", auth: client });
}
