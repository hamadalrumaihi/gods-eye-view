import {
  googleServerApiKey,
  keylessGooglePlacesResponse,
} from './google-key.js';
import { googleRateLimiter, clientKey } from '../common/rate-limit.js';
import { fetchBounded } from '../common/http.js';
import {
  projectNearbyPlaces,
  projectTextSearchPlaces,
} from '../../../src/data/placeProviderPayloads.js';

/** Deadline for one Places call, headers plus body. */
const PLACES_TIMEOUT_MS = 10_000;
/** Twenty places with the field mask below are a few tens of KB. */
const PLACES_MAX_RESPONSE_BYTES = 1024 * 1024;
/** The one message a client sees for any upstream or transport failure. */
const PLACES_FAILED = 'Google Places request failed';

/**
 * POST a Places request and parse its JSON. The upstream's own error wording
 * (quota phrasing, project ids) stays in the server log: the response to the
 * browser carries only PLACES_FAILED.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {string} apiKey
 * @param {string[]} fieldMask
 * @param {object} payload
 * @returns {Promise<{response: Response, data: object}>}
 */
async function postPlaces(fetchImpl, url, apiKey, fieldMask, payload) {
  const { response, body } = await fetchBounded(fetchImpl, url, {
    method: 'POST',
    redirect: 'error',
    timeoutMs: PLACES_TIMEOUT_MS,
    maxBytes: PLACES_MAX_RESPONSE_BYTES,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask.join(','),
    },
    body: JSON.stringify(payload),
  });
  let data = {};
  try {
    data = JSON.parse(body);
  } catch {
    data = {};
  }
  if (!response.ok) {
    const detail = String(data?.error?.message || '').slice(0, 200);
    console.warn(
      `[google-places] upstream HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  return { response, data };
}

/** Write one JSON answer with the `places` contract every response keeps. */
function sendPlaces(res, statusCode, payload, cacheControl) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (cacheControl) res.setHeader('Cache-Control', cacheControl);
  res.end(JSON.stringify(payload));
}

/** Validate raw lat/lon presence and WGS84 bounds before consuming request quota. */
export function validatePlacesCoordinates(searchParams) {
  const rawLat = searchParams.get('lat');
  const rawLon = searchParams.get('lon');
  if (rawLat === null || rawLon === null || !rawLat.trim() || !rawLon.trim()) {
    return { ok: false, error: 'lat and lon are required' };
  }
  const latitude = Number(rawLat);
  const longitude = Number(rawLon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, error: 'Valid lat and lon are required' };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return {
      ok: false,
      error: 'lat must be within [-90, 90] and lon within [-180, 180]',
    };
  }
  return { ok: true, latitude, longitude };
}

/** Nearby place labels and view-biased text search, with request-time key resolution. */
export function googlePlacesContextProxy({
  resolveApiKey = googleServerApiKey,
  fetchImpl = (...args) => fetch(...args),
  endpoints = {},
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/google/nearby-places', async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Keyless place context has no provider cost, so it resolves before the
      // paid-endpoint limiter can consume or exhaust quota (mirrors the HUD
      // summary route).
      const apiKey = resolveApiKey();
      const keyless = keylessGooglePlacesResponse(apiKey);
      if (keyless) {
        res.statusCode = keyless.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(keyless.payload));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const coordinates = validatePlacesCoordinates(requestUrl.searchParams);
      if (!coordinates.ok) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: coordinates.error, places: [] }));
        return;
      }
      const { latitude, longitude } = coordinates;

      // Per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN, default 120/min; `0`/`off`
      // opts out). Inlined (not the shared helper) so the 429 body keeps this
      // endpoint's `places: []` contract that the client expects on every error.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(clientKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const radiusM = Math.max(
        25,
        Math.min(5000, Number(requestUrl.searchParams.get('radiusM')) || 250),
      );

      try {
        const { response, data } = await postPlaces(
          fetchImpl,
          endpoints.nearby ||
            'https://places.googleapis.com/v1/places:searchNearby',
          apiKey,
          [
            'places.id',
            'places.displayName',
            'places.formattedAddress',
            'places.shortFormattedAddress',
            'places.location',
            'places.primaryType',
            'places.primaryTypeDisplayName',
            'places.types',
          ],
          {
            maxResultCount: 20,
            rankPreference: 'DISTANCE',
            locationRestriction: {
              circle: {
                center: { latitude, longitude },
                radius: radiusM,
              },
            },
          },
        );
        const places = projectNearbyPlaces(data, latitude, longitude);
        sendPlaces(
          res,
          response.ok ? 200 : response.status,
          { places, error: response.ok ? null : PLACES_FAILED },
          'private, max-age=300',
        );
      } catch (error) {
        // A transport fault names the upstream host or the cap; the client
        // only needs to know the lookup failed.
        console.warn('[google-places] nearby request failed');
        sendPlaces(res, 502, { error: PLACES_FAILED, places: [] });
      }
    });

    // Text Search: resolve a named landmark/POI to a real coordinate, biased to
    // the view. Geocoding scatters obscure monument/POI names across the city;
    // a view-biased Text Search lands on the actual feature. Same key, field
    // mask, throttle, and `places: []` error contract as nearby-places above.
    middlewares.use('/api/google/text-search', async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Keyless place context has no provider cost, so it resolves before the
      // paid-endpoint limiter can consume or exhaust quota (mirrors the HUD
      // summary route).
      const apiKey = resolveApiKey();
      const keyless = keylessGooglePlacesResponse(apiKey);
      if (keyless) {
        res.statusCode = keyless.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(keyless.payload));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const textQuery = String(requestUrl.searchParams.get('q') || '').trim();
      if (!textQuery) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ error: 'q, lat and lon are required', places: [] }),
        );
        return;
      }
      const coordinates = validatePlacesCoordinates(requestUrl.searchParams);
      if (!coordinates.ok) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: coordinates.error, places: [] }));
        return;
      }
      const { latitude, longitude } = coordinates;

      // Per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN, default 120/min; `0`/`off`
      // opts out). Inlined (like nearby-places) so the 429 body keeps the
      // `places: []` contract the client expects on every error response.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(clientKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const radiusM = Math.max(
        50,
        Math.min(50000, Number(requestUrl.searchParams.get('radiusM')) || 4000),
      );

      try {
        const { response, data } = await postPlaces(
          fetchImpl,
          endpoints.textSearch ||
            'https://places.googleapis.com/v1/places:searchText',
          apiKey,
          [
            'places.id',
            'places.displayName',
            'places.formattedAddress',
            'places.location',
            'places.viewport',
            'places.primaryType',
            'places.types',
          ],
          {
            textQuery,
            locationBias: {
              circle: {
                center: { latitude, longitude },
                radius: radiusM,
              },
            },
            maxResultCount: 5,
          },
        );
        const places = projectTextSearchPlaces(data, latitude, longitude);
        sendPlaces(
          res,
          response.ok ? 200 : response.status,
          { places, error: response.ok ? null : PLACES_FAILED },
          'private, max-age=300',
        );
      } catch (error) {
        console.warn('[google-places] text search request failed');
        sendPlaces(res, 502, { error: PLACES_FAILED, places: [] });
      }
    });
  }

  return {
    name: 'google-places-context-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
