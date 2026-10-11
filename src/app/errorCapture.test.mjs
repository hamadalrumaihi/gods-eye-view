// Global error capture for the application debug handle (audit T14, client).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createErrorCapture } from './errorCapture.js';

function errorEvent(error, message = error?.message) {
  return Object.assign(new Event('error'), { error, message });
}

function rejectionEvent(reason) {
  return Object.assign(new Event('unhandledrejection'), { reason });
}

test('an error event and an unhandled rejection each add one entry', () => {
  const target = new EventTarget();
  const capture = createErrorCapture({ target });
  target.dispatchEvent(errorEvent(new Error('boom')));
  target.dispatchEvent(rejectionEvent(new TypeError('rejected')));
  const entries = capture.getEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'error');
  assert.equal(entries[0].message, 'boom');
  assert.match(entries[0].stack, /boom/);
  assert.ok(Number.isFinite(entries[0].at));
  assert.equal(entries[1].kind, 'unhandledrejection');
  assert.equal(entries[1].message, 'rejected');
  assert.deepEqual(Object.keys(entries[1]).sort(), [
    'at',
    'kind',
    'message',
    'stack',
  ]);
  capture.clear();
  assert.deepEqual(capture.getEntries(), []);
  capture.dispose();
});

test('the ring buffer keeps the newest 200 entries', () => {
  const target = new EventTarget();
  const capture = createErrorCapture({ target });
  for (let index = 0; index < 201; index += 1) {
    target.dispatchEvent(rejectionEvent(`reason ${index}`));
  }
  const entries = capture.getEntries();
  assert.equal(entries.length, 200);
  assert.equal(entries[0].message, 'reason 1', 'the oldest entry is evicted');
  assert.equal(entries.at(-1).message, 'reason 200');
  capture.dispose();
});

test('dispose removes the listeners and getEntries returns copies', () => {
  const target = new EventTarget();
  const capture = createErrorCapture({ target, limit: 5 });
  target.dispatchEvent(errorEvent(null, 'script error'));
  const snapshot = capture.getEntries();
  snapshot[0].message = 'mutated';
  assert.equal(capture.getEntries()[0].message, 'script error');
  capture.dispose();
  capture.dispose();
  target.dispatchEvent(errorEvent(new Error('after dispose')));
  target.dispatchEvent(rejectionEvent('after dispose'));
  assert.equal(capture.getEntries().length, 1);
});

test('entries carry only message and stack text, with credential query values redacted', () => {
  const target = new EventTarget();
  const capture = createErrorCapture({ target });
  const error = new Error(
    'HTTP 403 https://maps.example/tiles?x=1&key=AIzaSecretValue&token=abc123 failed',
  );
  error.body = '{"secret":"payload"}';
  target.dispatchEvent(errorEvent(error));
  target.dispatchEvent(
    rejectionEvent({ message: 'plain object', body: 'payload' }),
  );
  target.dispatchEvent(rejectionEvent(undefined));
  const [first, second, third] = capture.getEntries();
  assert.equal(
    first.message,
    'HTTP 403 https://maps.example/tiles?x=1&key=[redacted]&token=[redacted] failed',
  );
  assert.doesNotMatch(first.stack, /AIzaSecretValue|abc123/);
  assert.equal('body' in first, false);
  assert.deepEqual(second, {
    ...second,
    kind: 'unhandledrejection',
    message: 'plain object',
  });
  assert.equal('body' in second, false);
  assert.equal(third.message, 'Error');
  capture.dispose();
});
