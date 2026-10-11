import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createLruCache } from '../common/cache.js';
/**
 * adsbdb.com enrichment proxy: callsign → route (airline + origin/destination
 * airports) and hex → aircraft type/registration. Free community API — cached
 * aggressively: ONE upstream request per new key ever (404s negative-cached),
 * persisted to disk so restarts don't re-hammer it. Adapted from skylight
 * (MIT) server/src/enrich/routes.ts.
 */
export function adsbdbProxy() {
  const TTL_MS = 24 * 3600_000;
  /** Keys are client-chosen callsigns/hex ids, so each store is bounded. */
  const CACHE_MAX_ENTRIES = 5000;
  const CACHE_PATH = path.join(process.cwd(), '.gev-cache', 'adsbdb.json');
  // Values keep the on-disk `{at, data}` shape; the cache's own clock handles
  // the TTL and the entry's `at` seeds it so a reload does not reset aging.
  const cache = {
    routes: createLruCache({ max: CACHE_MAX_ENTRIES, ttlMs: TTL_MS }),
    aircraft: createLruCache({ max: CACHE_MAX_ENTRIES, ttlMs: TTL_MS }),
  };
  let dirty = false;
  let loaded = false;
  const inflight = new Map();

  /** Load one persisted store, oldest first so the cap keeps the newest. */
  function restore(store, persisted) {
    const entries = Object.entries(persisted ?? {}).filter(
      ([, entry]) => Number.isFinite(entry?.at) && 'data' in entry,
    );
    entries.sort((a, b) => a[1].at - b[1].at);
    for (const [key, entry] of entries) store.set(key, entry, entry.at);
  }

  const persisted = () => ({
    routes: Object.fromEntries(cache.routes.entries()),
    aircraft: Object.fromEntries(cache.aircraft.entries()),
  });

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      restore(cache.routes, parsed.routes);
      restore(cache.aircraft, parsed.aircraft);
    } catch {
      /* first run */
    }
    setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
        await fsp.writeFile(CACHE_PATH, JSON.stringify(persisted()), 'utf8');
      } catch {
        dirty = true;
      } // retry next tick
    }, 15_000).unref?.();
  }

  /** A live `{at, data}` entry for `key`, or undefined once it has expired. */
  const fresh = (store, key) => store.get(key);

  function parseRoute(json) {
    const fr = json?.response?.flightroute;
    if (!fr?.origin || !fr?.destination) return null;
    const airport = (a) => ({
      code: a.iata_code || a.icao_code || '',
      name: a.municipality || a.name || '',
      lat: Number.isFinite(a.latitude) ? a.latitude : null,
      lon: Number.isFinite(a.longitude) ? a.longitude : null,
    });
    return {
      airline: fr.airline?.name || null,
      origin: airport(fr.origin),
      destination: airport(fr.destination),
    };
  }

  function parseAircraft(json) {
    const a = json?.response?.aircraft;
    if (!a) return null;
    return {
      typeCode: a.icao_type || null, // ICAO designator, e.g. "B738" — feeds classifyAircraft
      typeName:
        a.manufacturer && a.type
          ? `${a.manufacturer} ${a.type}`
          : a.type || null,
      registration: a.registration || null,
    };
  }

  function lookup(kind, key) {
    const store = kind === 'route' ? cache.routes : cache.aircraft;
    const hit = fresh(store, key);
    if (hit) return Promise.resolve(hit.data);
    const ik = `${kind}:${key}`;
    if (!inflight.has(ik)) {
      inflight.set(
        ik,
        (async () => {
          try {
            const url =
              kind === 'route'
                ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`
                : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
              const data =
                kind === 'route'
                  ? parseRoute(await res.json())
                  : parseAircraft(await res.json());
              store.set(key, { at: Date.now(), data }); // data may be null — negative cache
              dirty = true;
              return data;
            }
            if (res.status === 404) {
              store.set(key, { at: Date.now(), data: null }); // known-missing — cache the miss
              dirty = true;
            }
            // other statuses: leave uncached so we retry later
            return fresh(store, key)?.data ?? null;
          } catch {
            return fresh(store, key)?.data ?? null; // network error → stale if any
          } finally {
            inflight.delete(ik);
          }
        })(),
      );
    }
    return inflight.get(ik);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/adsbdb', async (req, res) => {
      await loadOnce();
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      try {
        const [, kind, rawKey] = String(req.url || '')
          .split('?')[0]
          .split('/');
        if (kind === 'route') {
          const cs = String(rawKey || '').toUpperCase();
          if (!/^[A-Z0-9]{2,8}$/.test(cs))
            return send(400, { error: 'invalid callsign' });
          const data = await lookup('route', cs);
          return send(200, data ? { found: true, ...data } : { found: false });
        }
        if (kind === 'type') {
          const hex = String(rawKey || '').toLowerCase();
          if (!/^[0-9a-f]{6}$/.test(hex))
            return send(400, { error: 'invalid hex' });
          const data = await lookup('aircraft', hex);
          return send(200, data ? { found: true, ...data } : { found: false });
        }
        return send(404, { error: 'unknown endpoint' });
      } catch (err) {
        console.error('[adsbdb-proxy] request failed');
        return send(500, { error: 'adsbdb proxy error' });
      }
    });
  };
  return {
    name: 'adsbdb-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
