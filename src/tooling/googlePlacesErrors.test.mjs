import test from 'node:test';
import assert from 'node:assert/strict';
import { googlePlacesContextProxy } from '../../server/providers/places/google.js';

const LEAK =
  'API key not valid for project fixture-project-123; see console.cloud.google.com/fixture';

function install(fetchImpl) {
  const routes = new Map();
  googlePlacesContextProxy({
    resolveApiKey: () => 'fixture-server-key',
    fetchImpl,
  }).configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return async (route, url, peer = 'fixture-peer') => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        this.body = String(body);
      },
    };
    await routes.get(route)(
      { url, method: 'GET', socket: { remoteAddress: peer } },
      res,
    );
    return res;
  };
}

test('an upstream 403 with a descriptive message yields the fixed string only, with the detail logged', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const seen = [];
  const request = install(async (url, options) => {
    seen.push({ url, options });
    return Response.json({ error: { message: LEAK } }, { status: 403 });
  });
  for (const [route, query] of [
    ['/api/google/nearby-places', '/?lat=30&lon=-97'],
    ['/api/google/text-search', '/?q=capitol&lat=30&lon=-97'],
  ]) {
    const res = await request(route, query);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(JSON.parse(res.body), {
      places: [],
      error: 'Google Places request failed',
    });
    assert.equal(res.body.includes('fixture-project-123'), false);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(
      res.headers['content-type'],
      'application/json; charset=utf-8',
    );
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /upstream HTTP 403: API key not valid/);
  assert.equal(seen.length, 2);
  for (const { options } of seen) {
    assert.ok(
      options.signal instanceof AbortSignal,
      'the call carries a deadline',
    );
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Goog-Api-Key'], 'fixture-server-key');
  }
});

test('transport faults and oversized answers also yield the fixed string', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const faulted = install(async () => {
    throw Error(`getaddrinfo ENOTFOUND places.googleapis.com ${LEAK}`);
  });
  const fault = await faulted('/api/google/nearby-places', '/?lat=30&lon=-97');
  assert.equal(fault.statusCode, 502);
  assert.deepEqual(JSON.parse(fault.body), {
    error: 'Google Places request failed',
    places: [],
  });
  assert.equal(fault.body.includes('googleapis'), false);

  const oversized = install(
    async () =>
      new Response('{"places":[]}', {
        headers: {
          'content-type': 'application/json',
          'content-length': String(2 * 1024 * 1024),
        },
      }),
  );
  const big = await oversized(
    '/api/google/text-search',
    '/?q=x&lat=30&lon=-97',
  );
  assert.equal(big.statusCode, 502);
  assert.deepEqual(JSON.parse(big.body), {
    error: 'Google Places request failed',
    places: [],
  });
});
