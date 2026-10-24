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
  const statusCode = Number(status);
  const data = err?.response?.data || err?.errors;
  const reason = Array.isArray(data?.errors) ? data.errors[0]?.reason : data?.errors?.[0]?.reason;
  const detail = JSON.stringify(reason ? { reason, data } : data);
  const authMessage = `${err?.message || ""} ${detail}`.toLowerCase();

  // Credentials can fail before the recorded access-token expiry, for example
  // when a refresh token is revoked or the stored token is otherwise invalid.
  if (
    statusCode === 401 ||
    reason === "authsubForbidden" ||
    reason === "invalidCredentials" ||
    reason === "invalidGrant" ||
    reason === "insufficientScope" ||
    /invalid authentication credentials|expected oauth 2 access token|invalid_grant|insufficient authentication scopes/.test(authMessage)
  ) {
    return new AuthError(`YouTube auth error: ${err?.message || detail || status}`);
  }

  // Rate-limit / quota
  if (
    statusCode === 429 ||
    statusCode === 403 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    reason === "rateLimitExceeded" ||
    reason === "quotaExceeded" ||
    reason === "userRateLimitExceeded"
  ) {
    let retryAfter = null;
    const ra = err?.headers?.get?.("retry-after") || err?.response?.headers?.["retry-after"];
    if (ra) retryAfter = parseInt(String(ra).replace(/[^0-9]/g, ""), 10);
    return new RateLimitError(`YouTube rate/limit: ${reason || status} ${detail}`, retryAfter);
  }

  // Fatal / non-retryable.
  if (statusCode === 400 || reason === "videoTooLong" || reason === "invalid") {
    return new FatalUploadError(`YouTube rejected upload: ${detail}`);
  }

  // Anything else that looks network-y.
  if (statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return new RateLimitError(`YouTube transient: ${statusCode} ${detail}`);
  }

  return new SchedulerError(`YouTube error: ${detail}`, "transient");
}
