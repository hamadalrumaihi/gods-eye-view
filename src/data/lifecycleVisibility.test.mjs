// Hidden-host polling pause for LayerLifecycle (audit T1).
//
// Periodic refresh ticks are manager-owned timers. While the host reports
// itself hidden they poll for nobody, so the manager skips them, remembers
// the skipped tick and runs exactly one refresh per enabled layer on return.
// Modules that read local hardware opt out with `pollWhileHidden = true`.
// The portable module never touches `document`: the host injects visibility.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayerLifecycle } from './lifecycle.js';

function fakeTimers(t) {
  const saved = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const intervals = new Map();
  let nextId = 1;
  globalThis.setInterval = (callback) => {
    const id = nextId++;
    intervals.set(id, callback);
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };
  t.after(() => Object.assign(globalThis, saved));
  return {
    intervals,
    /** Fire every armed interval once and let the resulting updates settle. */
    async tick(times = 1) {
      for (let index = 0; index < times; index += 1) {
        for (const callback of [...intervals.values()]) callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

function fakeVisibility() {
  const listeners = new Set();
  const visibility = {
    hidden: false,
    isHidden: () => visibility.hidden,
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    async set(hidden) {
      visibility.hidden = hidden;
      for (const listener of listeners) listener();
      await new Promise((resolve) => setImmediate(resolve));
    },
    get listenerCount() {
      return listeners.size;
    },
  };
  return visibility;
}

function makeLayer(id, extra = {}) {
  const calls = { update: 0 };
  return {
    calls,
    module: {
      id,
      name: id,
      icon: '',
      source: 'test',
      updateInterval: 1000,
      init() {},
      enable() {},
      disable() {},
      async update() {
        calls.update += 1;
      },
      getStats() {
        return { count: 0, lastUpdate: null };
      },
      ...extra,
    },
  };
}

test('hidden hosts skip periodic ticks and refresh each enabled layer once on return', async (t) => {
  const timers = fakeTimers(t);
  const visibility = fakeVisibility();
  const manager = new LayerLifecycle({}, { visibility });
  const a = makeLayer('a');
  const b = makeLayer('b');
  const idle = makeLayer('idle');
  for (const layer of [a, b, idle]) manager.register(layer.module);
  await manager.setEnabled('a', true);
  await manager.setEnabled('b', true);
  assert.equal(
    a.calls.update,
    1,
    'the enable transaction runs the first update',
  );
  assert.equal(b.calls.update, 1);
  assert.equal(timers.intervals.size, 2);

  await visibility.set(true);
  await timers.tick(2);
  assert.equal(a.calls.update, 1, 'no poll while hidden');
  assert.equal(b.calls.update, 1, 'no poll while hidden');
  assert.equal(manager.layers.get('a').pendingHiddenRefresh, true);

  await visibility.set(false);
  assert.equal(a.calls.update, 2, 'exactly one catch-up refresh');
  assert.equal(b.calls.update, 2, 'exactly one catch-up refresh');
  assert.equal(idle.calls.update, 0, 'disabled layers never refresh');
  assert.equal(manager.layers.get('a').pendingHiddenRefresh, false);

  await visibility.set(false);
  assert.equal(
    a.calls.update,
    2,
    'a visible host with nothing pending runs nothing',
  );
  await timers.tick();
  assert.equal(a.calls.update, 3, 'polling resumes while visible');
  await manager.destroyAll();
});

test('a layer that sets pollWhileHidden keeps polling behind a hidden host', async (t) => {
  const timers = fakeTimers(t);
  const visibility = fakeVisibility();
  const manager = new LayerLifecycle({}, { visibility });
  const local = makeLayer('local-adsb', { pollWhileHidden: true });
  const remote = makeLayer('remote');
  manager.register(local.module);
  manager.register(remote.module);
  await manager.setEnabled('local-adsb', true);
  await manager.setEnabled('remote', true);

  await visibility.set(true);
  await timers.tick(2);
  assert.equal(local.calls.update, 3, 'two hidden ticks still polled');
  assert.equal(remote.calls.update, 1);

  await visibility.set(false);
  assert.equal(
    local.calls.update,
    3,
    'nothing was deferred, so nothing catches up',
  );
  assert.equal(remote.calls.update, 2);
  await manager.destroyAll();
});

test('a layer disabled while hidden does not refresh when the host returns', async (t) => {
  const timers = fakeTimers(t);
  const visibility = fakeVisibility();
  const manager = new LayerLifecycle({}, { visibility });
  const layer = makeLayer('flights');
  manager.register(layer.module);
  await manager.setEnabled('flights', true);
  await visibility.set(true);
  await timers.tick();
  assert.equal(manager.layers.get('flights').pendingHiddenRefresh, true);
  await manager.setEnabled('flights', false);
  await visibility.set(false);
  assert.equal(layer.calls.update, 1, 'the OFF layer stays quiet');
  assert.equal(timers.intervals.size, 0);
  await manager.destroyAll();
});

test('without a visibility host polling never pauses, and destroyAll releases the subscription', async (t) => {
  const timers = fakeTimers(t);
  const portable = new LayerLifecycle({});
  const layer = makeLayer('portable');
  portable.register(layer.module);
  await portable.setEnabled('portable', true);
  await timers.tick(2);
  assert.equal(layer.calls.update, 3);
  await portable.destroyAll();

  const visibility = fakeVisibility();
  const hosted = new LayerLifecycle({}, { visibility });
  assert.equal(visibility.listenerCount, 1, 'one subscription per manager');
  await hosted.destroyAll();
  assert.equal(visibility.listenerCount, 0);
  await visibility.set(false);
});
