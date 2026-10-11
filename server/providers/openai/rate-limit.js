import {
  makeOptInRateLimiter,
  clientKey,
  RATE_LIMIT_DEFAULTS,
} from '../common/rate-limit.js';

// Built LAZILY on first request, NOT at module load: `.env` values are applied to process.env later
// (the plugin config hook calls loadEnv → process.env, AFTER this module is imported), so reading
// process.env here at import time would always see them unset and silently use the default even when
// configured via .env. Building on first request (like the OPENAI_API_KEY reads) sees the loaded env;
// the result is cached so the limiter's per-IP window state persists. `null` = unlimited (opted out).
let _openAiRateLimiter;

/**
 * OpenAI cost endpoints (realtime/token + hud-summary). Unset env uses
 * RATE_LIMIT_DEFAULTS.OPENAI_PER_MIN; `0`/`off` disables (null).
 */
function openAiRateLimiter() {
  if (_openAiRateLimiter === undefined)
    _openAiRateLimiter = makeOptInRateLimiter(
      process.env.GEV_RATELIMIT_OPENAI_PER_MIN,
      RATE_LIMIT_DEFAULTS.OPENAI_PER_MIN,
    );
  return _openAiRateLimiter;
}

/**
 * Apply a limiter to a request, writing a 429 when over the cap.
 * When `limiter` is null (the operator set `0`/`off`) this is a no-op
 * returning `true`, so the handler proceeds unthrottled.
 *
 * @param {((key:string)=>boolean)|null} limiter
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} True if the request may proceed; false if a 429 was sent.
 */
function enforceOptInRateLimit(limiter, req, res) {
  if (!limiter) return true; // unlimited (opted out) — no behavior change
  if (limiter(clientKey(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Retry-After', '5');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}

export { enforceOptInRateLimit, openAiRateLimiter };
