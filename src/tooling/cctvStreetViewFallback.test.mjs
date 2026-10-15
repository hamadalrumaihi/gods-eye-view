import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../../server/providers/cctv.js';

// The shared Google limiter is built once per process from the environment at
// its first use, so the ceiling is pinned before any request runs.
process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = '2';

function install(plugin, remoteAddress = '::1') {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  return async (url) => {
    const res = {
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url, method: 'GET', socket: { remoteAddress } }, res);
    return res;
  };
}

function env(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

test('Street View is fetched only for registered cameras, from cache, under the Google limiter', async (t) => {
  for (const name of ['CCTV_SOURCES_FILE', 'CCTV_FORCE_AUSTIN'])
    env(t, name, undefined);
  env(t, 'GOOGLE_MAPS_SERVER_API_KEY', 'fixture-server-key');
  env(t, 'GOOGLE_MAPS_API_KEY', '');
  env(
    t,
    'CCTV_SOURCES_JSON',
    JSON.stringify([
      {
        id: 'registered',
        name: 'Registered camera',
        lat: 30.27,
        lon: -97.74,
        headingDeg: 90,
        fovDeg: 60,
        pitchDeg: 5,
        feedType: 'image',
      },
    ]),
  );
  const root = mkdtempSync(path.join(tmpdir(), 'gev-cctv-sv-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config/cctv_sources.austin.json'), '[]');
  const request = install(cctvProxy({ sourceRoot: root }));
  // Resolve the catalog before counting upstream calls.
  await request('/sources');

  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    fetched.push({ url: new URL(url), options });
    return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
  });

  // An unknown id never spends a billed request, whatever pose it carries.
  const unknown = await request(
    '/frame/unknown?lat=30.27&lon=-97.74&heading=10&fov=90&pitch=0',
  );
  assert.equal(unknown.status, 200);
  assert.equal(unknown.headers['X-CCTV-Source'], 'synthetic');
  assert.equal(fetched.length, 0);

  // A registered id fetches once, at the REGISTERED position, with the client
  // overrides clamped; the second identical request is served from cache.
  const first = await request(
    '/frame/registered?lat=0&lon=0&heading=450&fov=999&pitch=-99',
  );
  assert.equal(first.status, 200);
  assert.equal(first.headers['X-CCTV-Source'], 'streetview');
  assert.equal(first.headers['Content-Type'], 'image/jpeg');
  assert.deepEqual([...first.body], [...JPEG]);
  assert.equal(fetched.length, 1);
  const sent = fetched[0].url;
  assert.equal(sent.hostname, 'maps.googleapis.com');
  assert.equal(sent.searchParams.get('location'), '30.27,-97.74');
  assert.equal(sent.searchParams.get('heading'), '90');
  assert.equal(sent.searchParams.get('fov'), '120');
  assert.equal(sent.searchParams.get('pitch'), '-40');
  assert.equal(sent.searchParams.get('key'), 'fixture-server-key');
  assert.equal(fetched[0].options.redirect, 'error');
  assert.ok(!first.body.toString().includes('fixture-server-key'));
  const again = await request(
    '/frame/registered?heading=450&fov=999&pitch=-99',
  );
  assert.equal(again.headers['X-CCTV-Source'], 'streetview');
  assert.equal(fetched.length, 1, 'the cached frame costs no second request');

  // The registered pose is the default when the client sends none.
  const registeredPose = await request('/frame/registered');
  assert.equal(registeredPose.headers['X-CCTV-Source'], 'streetview');
  assert.equal(fetched.length, 2);
  assert.equal(fetched[1].url.searchParams.get('heading'), '90');
  assert.equal(fetched[1].url.searchParams.get('fov'), '60');
  assert.equal(fetched[1].url.searchParams.get('pitch'), '5');

  // Two billed requests were the whole per-minute allowance: a third distinct
  // pose meets the shared limiter's sanitized 429, while cached poses still
  // serve.
  const limited = await request('/frame/registered?heading=10');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Content-Type'], 'application/json');
  assert.equal(limited.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(limited.headers['Retry-After'], '5');
  assert.deepEqual(JSON.parse(limited.body), { error: 'Rate limit exceeded' });
  assert.equal(fetched.length, 2);
  const cached = await request('/frame/registered');
  assert.equal(cached.headers['X-CCTV-Source'], 'streetview');
  assert.equal(fetched.length, 2);

  // Without a Google key a registered camera falls through to the placeholder
  // before the limiter is consulted.
  process.env.GOOGLE_MAPS_SERVER_API_KEY = '';
  const keyless = await request('/frame/registered?heading=20');
  assert.equal(keyless.status, 200);
  assert.equal(keyless.headers['X-CCTV-Source'], 'synthetic');
  assert.equal(fetched.length, 2);
});

test('an oversized or non-image Street View answer falls through to the placeholder', async (t) => {
  for (const name of ['CCTV_SOURCES_FILE', 'CCTV_FORCE_AUSTIN'])
    env(t, name, undefined);
  env(t, 'GOOGLE_MAPS_SERVER_API_KEY', 'fixture-server-key');
  env(
    t,
    'CCTV_SOURCES_JSON',
    JSON.stringify([
      { id: 'big', name: 'Big', lat: 30.27, lon: -97.74, feedType: 'image' },
    ]),
  );
  const root = mkdtempSync(path.join(tmpdir(), 'gev-cctv-sv-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config/cctv_sources.austin.json'), '[]');
  // The previous test exhausted the shared limiter's window for its peer; this
  // peer has its own.
  const call = install(cctvProxy({ sourceRoot: root }), 'oversized-peer');
  await call('/sources');
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JPEG, {
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(17 * 1024 * 1024),
        },
      }),
  );
  const oversized = await call('/frame/big');
  assert.equal(oversized.headers['X-CCTV-Source'], 'synthetic');
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('<html>no imagery</html>', {
        headers: { 'content-type': 'text/html' },
      }),
  );
  const html = await call('/frame/big?heading=1');
  assert.equal(html.headers['X-CCTV-Source'], 'synthetic');
});
