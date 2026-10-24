import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { nowSec } from "../db.js";

const MEDIA_URL_TTL_SECONDS = 24 * 60 * 60;

export function createSignedMediaUrl(filename) {
  if (!config.mediaSigningSecret) throw new Error("Set MEDIA_SIGNING_SECRET or configure a Meta app secret to sign staged media URLs.");
  const expires = nowSec() + MEDIA_URL_TTL_SECONDS;
  const signature = createHmac("sha256", config.mediaSigningSecret)
    .update(`${filename}:${expires}`)
    .digest("hex");
  const url = new URL(`/media/${encodeURIComponent(filename)}`, config.instagram.publicAppUrl);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature);
  return url;
}

export function verifySignedMediaUrl(filename, expiresValue, signature) {
  if (!config.mediaSigningSecret || typeof expiresValue !== "string") return false;
  const expires = Number(expiresValue);
  const now = nowSec();
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + MEDIA_URL_TTL_SECONDS) return false;
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", config.mediaSigningSecret)
    .update(`${filename}:${expires}`)
    .digest();
  const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
