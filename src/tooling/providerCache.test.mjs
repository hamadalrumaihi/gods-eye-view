import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { createLruCache } from '../../server/providers/common/cache.js';
import { celestrakProxy } from '../../server/providers/space/celestrak.js';
import { adsbdbProxy } from '../../server/providers/aircraft/enrichment.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await [...routes.values()][0]({ url, method }, res);
    return res;
  };
}

function isolateDisk(t, { readFile } = {}) {
  t.mock.method(
    fsp,
    'readFile',
    readFile ||
      (async () => {
        throw Error('no cache');
      }),
  );
  t.mock.method(fsp, 'mkdir', async () => {});
  const writes = [];
  t.mock.method(fsp, 'writeFile', async (_path, text) => {
    writes.push(text);
  });
  t.mock.method(console, 'warn', () => {});
  return writes;
}

test('the LRU cache evicts its oldest entry past the cap and reads refresh recency', () => {
  const cache = createLruCache({ max: 3 });
  cache.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(cache.get('a'), 1, 'a is read and becomes the newest');
  cache.set('d', 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('b'), undefined, 'b was the oldest unread entry');
  assert.deepEqual([...cache.keys()], ['c', 'a', 'd']);
  assert.deepEqual(
    [...cache.entries()],
    [
      ['c', 3],
      ['a', 1],
      ['d', 4],
    ],
  );
  assert.equal(cache.delete('c'), true);
  assert.equal(cache.has('c'), false);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.throws(() => createLruCache({ max: 0 }), /positive/);
  assert.throws(() => createLruCache(), /positive/);
});

test('the LRU cache applies its TTL on read from the entry timestamp', () => {
  let now = 1_000_000;
  const cache = createLruCache({ max: 10, ttlMs: 60_000, now: () => now });
  cache.set('fresh', 'f');
  cache.set('restored', 'r', now - 59_000);
  assert.equal(cache.has('fresh'), true);
  assert.equal(cache.get('restored'), 'r');
  now += 1_500;
  assert.equal(cache.get('restored'), undefined, 'ages from its own `at`');
  assert.equal(cache.has('restored'), false);
  assert.equal(cache.get('fresh'), 'f');
  now += 60_000;
  assert.equal(
    cache.has('fresh'),
    false,
    'has() reports an expired entry as absent',
  );
  assert.equal(cache.size, 0, 'expired entries are dropped when they are read');
});

test('CelesTrak answers an unknown group from its negative cache for a minute', async (t) => {
  isolateDisk(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('not found', { status: 404 });
  });
  const request = install(celestrakProxy());
  const first = await request('/garbage');
  assert.equal(first.status, 502);
  assert.equal(first.headers['x-tle-cache'], 'NONE');
  const second = await request('/garbage');
  assert.equal(second.status, 502);
  assert.equal(
    calls,
    1,
    'the second request inside a minute never reaches upstream',
  );
  now += 61_000;
  await request('/garbage');
  assert.equal(calls, 2, 'the group is retried once the minute has passed');
  assert.equal((await request('/other')).status, 502);
  assert.equal(calls, 3, 'other groups are unaffected by one failing name');
});

test('adsbdb enrichment bounds its stores and persists the same on-disk shape', async (t) => {
  const persistedRoutes = Object.fromEntries(
    Array.from({ length: 5001 }, (_, i) => [
      `OLD${i}`,
      { at: 1_000_000 + i, data: { airline: `Airline ${i}` } },
    ]),
  );
  const writes = isolateDisk(t, {
    readFile: async () =>
      JSON.stringify({ routes: persistedRoutes, aircraft: {} }),
  });
  let flush;
  t.mock.method(globalThis, 'setInterval', (fn) => {
    flush = fn;
    return { unref() {} };
  });
  let now = 2_000_000;
  t.mock.method(Date, 'now', () => now);
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetched.push(url);
    return new Response('', { status: 404 });
  });
  const request = install(adsbdbProxy());
  const newest = JSON.parse((await request('/route/OLD5000')).body);
  assert.equal(newest.airline, 'Airline 5000');
  assert.equal(
    fetched.length,
    0,
    'the newest persisted entry survived the cap',
  );
  const oldest = JSON.parse((await request('/route/OLD0')).body);
  assert.deepEqual(oldest, { found: false });
  assert.equal(
    fetched.length,
    1,
    'the oldest entry was evicted on load and re-fetched',
  );
  await flush();
  const persisted = JSON.parse(writes.at(-1));
  assert.deepEqual(Object.keys(persisted), ['routes', 'aircraft']);
  assert.equal(Object.keys(persisted.routes).length, 5000);
  assert.deepEqual(persisted.routes.OLD0, { at: now, data: null });
  assert.deepEqual(persisted.routes.OLD5000, persistedRoutes.OLD5000);
  assert.equal('OLD1' in persisted.routes, false);
});
