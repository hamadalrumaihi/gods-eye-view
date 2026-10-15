import { makeRateLimiter } from '../../../src/sources/rateLimit.js';
export { makeRateLimiter } from '../../../src/sources/rateLimit.js';

/**
 * Per-IP requests/minute applied when the matching GEV_RATELIMIT_* variable is
 * unset. The same figures the Pinokio launcher writes into a fresh
 * ENVIRONMENT (scripts/pinokio-environment.mjs), so a terminal launch and a
 * Pinokio launch spend at the same ceiling.
 */
export const RATE_LIMIT_DEFAULTS = Object.freeze({
  OPENAI_PER_MIN: 30,
  GOOGLE_PER_MIN: 120,
});

/**
 * Resolve a GEV_RATELIMIT_* value to requests/minute, or null for unlimited.
 * Unset or blank uses `defaultPerMin`; an explicit `0` or `off` disables the
 * limiter; a positive number is used as given (fractions floor). Anything
 * else — negative, non-numeric — is not a deliberate opt-out and keeps the
 * default rather than silently removing the cap.
 *
 * @param {string|undefined} envValue - Raw env value.
 * @param {number} defaultPerMin - Applied when the value is unset or blank.
 * @returns {number|null} Requests/minute, or null for unlimited.
 */
export function resolveRateLimitPerMin(envValue, defaultPerMin) {
  const fallback =
    Number.isFinite(defaultPerMin) && defaultPerMin > 0
      ? Math.floor(defaultPerMin)
      : null;
  const raw = String(envValue ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  if (raw === '0' || raw === 'off') return null;
  const max = Number(raw);
  if (Number.isFinite(max) && max > 0) return Math.floor(max);
  return fallback;
}

/**
 * Per-IP rate limiter for the cost-bearing API proxies (OpenAI / Google).
 * Built from a GEV_RATELIMIT_* value through resolveRateLimitPerMin: the
 * documented default applies when the variable is unset, an explicit `0` or
 * `off` returns `null` so the caller skips the check entirely, and a positive
 * integer N enables a fixed 60s window of N requests/IP. Callers build this
 * lazily once and reuse it so its per-IP window state persists across
 * requests. The global backstop is set to a generous multiple of the per-IP
 * cap so a single host can't starve the rest.
 *
 * @param {string|undefined} envValue - Raw env value (requests/min/IP).
 * @param {number} [defaultPerMin] - Applied when the value is unset; omit for unlimited.
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when unlimited.
 */
export function makeOptInRateLimiter(envValue, defaultPerMin) {
  const max = resolveRateLimitPerMin(envValue, defaultPerMin);
  if (max === null) return null;
  return makeRateLimiter({
    windowMs: 60_000,
    max,
    globalMax: max * 20,
  });
}

// Built LAZILY on first request, NOT at module load: `.env` values reach
// process.env after this module is imported (the config hook's loadEnv), so
// an import-time read would never see a configured value. undefined = not
// built yet; null = unlimited; fn = active limiter.
let _googleRateLimiter;

/**
 * The one Google limiter (GEV_RATELIMIT_GOOGLE_PER_MIN, default
 * RATE_LIMIT_DEFAULTS.GOOGLE_PER_MIN) shared by every billed Google call —
 * Places nearby/text search and the CCTV Street View fallback — so they draw
 * from the same per-IP window.
 *
 * @returns {((key:string)=>boolean)|null} An `allow(key)` fn, or null when unlimited.
 */
export function googleRateLimiter() {
  if (_googleRateLimiter === undefined)
    _googleRateLimiter = makeOptInRateLimiter(
      process.env.GEV_RATELIMIT_GOOGLE_PER_MIN,
      RATE_LIMIT_DEFAULTS.GOOGLE_PER_MIN,
    );
  return _googleRateLimiter;
}

/**
 * Client key for rate limiting. Uses the real socket peer address only — we do
 * NOT trust X-Forwarded-For (client-controlled; a rotating value would mint fresh
 * quota and grow the limiter map). This is a localhost dev proxy, so the socket
 * address is the real client.
 */
export function clientKey(req) {
  return String(req.socket?.remoteAddress || 'local');
}
