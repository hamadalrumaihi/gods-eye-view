import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBounded } from '../../server/providers/common/http.js';
import * as providers from '../../server/providers/live.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/', method = 'GET') => {
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [key, value] of Object.entries(headers))
          this.setHeader(key, value);
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)({ url, method }, response);
    return response;
  };
}

test('a transport that never settles rejects at the deadline', async () => {
  const seen = [];
  await assert.rejects(
    fetchBounded(
      (url, init) => {
        seen.push({ url, init });
        return new Promise(() => {});
      },
      'https://upstream.example/slow',
      { timeoutMs: 20 },
    ),
    (error) => {
      assert.equal(error.code, 'UPSTREAM_TIMEOUT');
      assert.equal(error.name, 'TimeoutError');
      return true;
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].init.redirect,
    'error',
    'redirects are refused by default',
  );
  assert.equal(
    seen[0].init.signal.aborted,
    true,
    'the transport is told to stop',
  );
});

test('a stalled body also rejects at the deadline', async () => {
  await assert.rejects(
    fetchBounded(
      async () => new Response(new ReadableStream({ pull() {} })),
      'https://upstream.example/stall',
      { timeoutMs: 20 },
    ),
    (error) => error.code === 'UPSTREAM_TIMEOUT',
  );
});

test('an oversized body rejects whether declared or streamed', async () => {
  await assert.rejects(
    fetchBounded(
      async () => new Response('x'.repeat(2048)),
      'https://u.example',
      {
        maxBytes: 1024,
      },
    ),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
  await assert.rejects(
    fetchBounded(
      async () =>
        new Response('x', { headers: { 'content-length': String(5 * 1024) } }),
      'https://u.example',
      { maxBytes: 1024 },
    ),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
  const { body } = await fetchBounded(
    async () => new Response('x'.repeat(1024)),
    'https://u.example',
    { maxBytes: 1024 },
  );
  assert.equal(body.length, 1024, 'exactly the cap is still accepted');
});

test('body kinds, request options and error bodies follow the caller', async () => {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true });
  };
  const json = await fetchBounded(transport, 'https://u.example/json', {
    as: 'json',
    method: 'POST',
    headers: { 'X-Fixture': '1' },
    body: '{"q":1}',
    redirect: 'manual',
  });
  assert.deepEqual(json.body, { ok: true });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{"q":1}');
  assert.equal(calls[0].init.headers['X-Fixture'], '1');
  assert.equal(calls[0].init.redirect, 'manual');

  const bytes = await fetchBounded(
    async () => new Response(new Uint8Array([1, 2, 3])),
    'https://u.example/bytes',
    { as: 'bytes' },
  );
  assert.deepEqual([...bytes.body], [1, 2, 3]);

  let cancelled = false;
  const failing = await fetchBounded(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 },
      ),
    'https://u.example/failing',
    { readErrorBody: false },
  );
  assert.equal(failing.response.status, 503);
  assert.equal(failing.body, null);
  assert.equal(cancelled, true, 'an unread failure body is cancelled');

  const read = await fetchBounded(
    async () => new Response('denied', { status: 403 }),
    'https://u.example/read',
  );
  assert.equal(
    read.body,
    'denied',
    'error bodies are read under the cap by default',
  );

  await assert.rejects(
    fetchBounded(transport, 'https://u.example', { as: 'blob' }),
    /unknown body kind/,
  );
});

test("the caller's own abort propagates as an abort, not a timeout", async () => {
  const controller = new AbortController();
  const pending = fetchBounded(
    () => new Promise(() => {}),
    'https://u.example',
    {
      signal: controller.signal,
      timeoutMs: 10_000,
    },
  );
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});

test('adsb.lol relays the upstream status but never its failure body', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('<html>internal upstream detail</html>', { status: 404 }),
  );
  const request = install(providers.adsbLolProxy());
  const result = await request('/api/adsblol/mil');
  assert.equal(result.statusCode, 404);
  assert.deepEqual(JSON.parse(result.body), {
    error: 'adsb.lol upstream unavailable',
  });
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
});

test('OpenSky treats an oversized worldwide snapshot as an upstream failure', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('{}', {
        headers: { 'content-length': String(17 * 1024 * 1024) },
      }),
  );
  const previous = process.env.OPENSKY_AUTH_MODE;
  process.env.OPENSKY_AUTH_MODE = 'anon';
  t.after(() => {
    if (previous === undefined) delete process.env.OPENSKY_AUTH_MODE;
    else process.env.OPENSKY_AUTH_MODE = previous;
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?oversized=${Date.now()}`
  );
  const result = await install(fresh.openSkyProxy())('/api/opensky');
  assert.equal(result.statusCode, 502);
  assert.deepEqual(JSON.parse(result.body), { error: 'OpenSky proxy error' });
});
