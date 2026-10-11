import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { createBrowserViteConfig } from '../../build/vite.js';
import { openAiRealtimeProxy } from '../../server/providers/openai.js';
import { keySetupEndpoint } from '../../server/standalone/key-setup.js';

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
    restart: async () => {},
  });
  return routes;
}

function request(
  handler,
  {
    method = 'GET',
    url = '/',
    body = '',
    contentType = 'application/json',
  } = {},
) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, {
      method,
      url,
      headers: {
        host: 'localhost:4173',
        origin: 'http://localhost:4173',
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(status, values) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(values)) this.setHeader(k, v);
      },
      end(body = '') {
        resolve({ status: this.statusCode, headers, body: String(body) });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

test('the Realtime debug log is a dev-server route that accepts JSON only', async (t) => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'gev-hygiene-'));
  t.after(() => rmSync(sourceRoot, { recursive: true, force: true }));
  assert.equal(
    install(openAiRealtimeProxy({ sourceRoot }), true).has(
      '/api/realtime/debug-log',
    ),
    false,
    'preview never installs the log sink',
  );
  const dev = install(openAiRealtimeProxy({ sourceRoot }));
  assert.ok(dev.has('/api/realtime/token'), 'the billed routes stay in both');
  const handler = dev.get('/api/realtime/debug-log');
  // `null` sends no Content-Type header at all.
  for (const contentType of [null, 'text/plain', 'multipart/form-data']) {
    const refused = await request(handler, {
      method: 'POST',
      body: '{"marker":1}',
      contentType,
    });
    assert.equal(refused.status, 415, `refuses ${contentType ?? 'no type'}`);
    assert.equal(refused.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(JSON.parse(refused.body), {
      error: 'Content-Type must be application/json',
    });
  }
  assert.equal(
    existsSync(path.join(sourceRoot, '.gev-logs')),
    false,
    'a refused request writes nothing',
  );
  const accepted = await request(handler, {
    method: 'POST',
    body: '{"marker":1}',
    contentType: 'application/json; charset=utf-8',
  });
  assert.equal(accepted.status, 204);
});

test('two concurrent Provider Settings saves of different keys both persist', async (t) => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'gev-hygiene-'));
  t.after(() => rmSync(sourceRoot, { recursive: true, force: true }));
  env(t, 'OPENAI_API_KEY', undefined);
  env(t, 'AISSTREAM_API_KEY', undefined);
  const handler = install(keySetupEndpoint({ sourceRoot })).get(
    '/api/setup/keys',
  );
  const [first, second] = await Promise.all([
    request(handler, {
      method: 'POST',
      body: JSON.stringify({
        OPENAI_API_KEY: 'sk-fixture-only-not-a-real-key',
      }),
    }),
    request(handler, {
      method: 'POST',
      body: JSON.stringify({ AISSTREAM_API_KEY: 'aisstream-fixture-only' }),
    }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.headers['x-content-type-options'], 'nosniff');
  const stored = parseEnv(readFileSync(path.join(sourceRoot, '.env'), 'utf8'));
  assert.equal(stored.OPENAI_API_KEY, 'sk-fixture-only-not-a-real-key');
  assert.equal(stored.AISSTREAM_API_KEY, 'aisstream-fixture-only');
  assert.equal(process.env.OPENAI_API_KEY, 'sk-fixture-only-not-a-real-key');
  assert.equal(process.env.AISSTREAM_API_KEY, 'aisstream-fixture-only');
});

test('the dev server denies the staged credential temp file alongside the store', () => {
  const { deny } = createBrowserViteConfig().server.fs;
  assert.ok(deny.includes('**/ENVIRONMENT'));
  assert.ok(deny.includes('**/.ENVIRONMENT.*.tmp'));
});
