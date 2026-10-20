/**
 * Classified errors thrown by the upload worker. The worker uses the `kind`
 * to decide: rate-limit/quota/backoff (retryable with delay), auth problems
 * (mark channel inactive, do not retry), and fatal client errors (fail the job).
 */

export class SchedulerError extends Error {
  /** kind: 'rate_limit' | 'auth' | 'fatal' | 'transient' */
  constructor(msg, kind) {
    super(msg);
    this.name = "SchedulerError";
    this.kind = kind;
  }
}

export class RateLimitError extends SchedulerError {
  constructor(msg, retryAfterSec = null) {
    super(msg, "rate_limit");
    this.retryAfterSec = retryAfterSec;
  }
}

export class AuthError extends SchedulerError {
  constructor(msg) {
    super(msg, "auth");
  }
}

export class FatalUploadError extends SchedulerError {
  // Non-retryable, e.g. video too long / file rejected by YouTube.
  constructor(msg) {
    super(msg, "fatal");
  }
}

export function fromGoogleError(err) {
  const status = err?.status || err?.code || err?.response?.status;
  const data = err?.response?.data || err?.errors;
  const reason = Array.isArray(data?.errors) ? data.errors[0]?.reason : data?.errors?.[0]?.reason;
  const detail = JSON.stringify(reason ? { reason, data } : data);

  // Rate-limit / quota
  if (
    status === 429 ||
    status === 403 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    reason === "rateLimitExceeded" ||
    reason === "quotaExceeded" ||
    reason === "userRateLimitExceeded"
  ) {
    let retryAfter = null;
    const ra = err?.headers?.get?.("retry-after") || err?.response?.headers?.["retry-after"];
    if (ra) retryAfter = parseInt(String(ra).replace(/[^0-9]/g, ""), 10);
    return new RateLimitError(`YouTube rate/limit: ${reason || status} ${detail}`, retryAfter);
  }

  // Auth problems — tokens revoked/expired. Do NOT retry the job; disable channel.
  if (
    status === 401 ||
    reason === "authsubForbidden" ||
    reason === "invalidCredentials" ||
    reason === "invalid Gracias token" ||
    reason === "invalidGrant" ||
    reason === "insufficientScope"
  ) {
    return new AuthError(`YouTube auth error: ${detail}`);
  }

  // Fatal / non-retryable.
  if (status === 400 || reason === "videoTooLong" || reason === "invalid") {
    return new FatalUploadError(`YouTube rejected upload: ${detail}`);
  }

  // Anything else that looks network-y.
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return new RateLimitError(`YouTube transient: ${status} ${detail}`);
  }

  return new SchedulerError(`YouTube error: ${detail}`, "transient");
}
