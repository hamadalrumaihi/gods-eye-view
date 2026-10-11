import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectKeyUpdates,
  keySetupChipLabel,
  stripKeylessBasemapFromHash,
  bindKeySetupPlacement,
} from './keySetup.js';

test('setup placement moves the same button only in Cyber and disconnects on teardown', () => {
  const home = {};
  const chip = { parentNode: home, hidden: true };
  const root = { parentNode: home, before: (node) => { node.parentNode = home; } };
  let moves = 0;
  const toolbar = { append: (node) => { moves++; node.parentNode = toolbar; } };
  const theme = { dataset: { uiTheme: 'tactical' } };
  let notify, disconnected = false;
  class Observer {
    constructor(callback) { notify = callback; }
    observe(target, options) {
      assert.equal(target, theme);
      assert.deepEqual(options.attributeFilter, ['data-ui-theme']);
    }
    disconnect() { disconnected = true; }
  }
  const dispose = bindKeySetupPlacement({
    documentElement: theme,
    getElementById: () => toolbar,
    defaultView: { MutationObserver: Observer },
  }, chip, root);
  assert.equal(chip.parentNode, home);
  for (const variant of ['cyber', 'operator', 'cyber', 'minimal']) {
    theme.dataset.uiTheme = variant;
    notify();
    assert.equal(chip.parentNode, variant === 'cyber' ? toolbar : home);
    notify();
  }
  assert.equal(moves, 2, 'identical theme sync does not reparent again');
  assert.equal(chip.hidden, true, 'placement cannot reveal a retired button');
  dispose();
  assert.equal(disconnected, true);
});

test('the chip counts what is missing, and retires the count at zero', () => {
  assert.equal(keySetupChipLabel({ setCount: 0, total: 8 }), 'POWER UP · 8 KEYS WAITING');
  assert.equal(keySetupChipLabel({ setCount: 7, total: 8 }), 'POWER UP · 1 KEY WAITING');
  assert.equal(keySetupChipLabel({ setCount: 8, total: 8 }), 'POWERED UP');
  assert.equal(keySetupChipLabel(null), 'POWERED UP', 'no status is not a broken label');
});

test('collectKeyUpdates keeps only non-empty trimmed values', () => {
  const updates = collectKeyUpdates([
    { envVar: 'OPENAI_API_KEY', value: '  sk-abc  ' },
    { envVar: 'FIRMS_MAP_KEY', value: '' },
    { envVar: 'TOMTOM_API_KEY', value: '   ' },
    { envVar: '', value: 'orphan' },
    null,
  ]);
  assert.deepEqual(updates, { OPENAI_API_KEY: 'sk-abc' });
  assert.deepEqual(collectKeyUpdates([]), {});
  assert.deepEqual(collectKeyUpdates(null), {});
});

test('the first Google key strips ONLY the keyless OSM basemap from the share hash', () => {
  const stripped = stripKeylessBasemapFromHash('lat=30.2&lon=-97.7&map=osm&style=normal');
  assert.ok(stripped !== null);
  const params = new URLSearchParams(stripped);
  assert.equal(params.get('map'), null, 'osm basemap removed');
  assert.equal(params.get('lat'), '30.2', 'camera survives');
  assert.equal(params.get('style'), 'normal', 'style survives');
  // A stack under any other name was chosen or shared on purpose.
  assert.equal(stripKeylessBasemapFromHash('map=bing-aerial&lat=1'), null);
  assert.equal(stripKeylessBasemapFromHash('lat=1&lon=2'), null, 'no stack, nothing to do');
  assert.equal(stripKeylessBasemapFromHash(''), null);
  assert.equal(stripKeylessBasemapFromHash(undefined), null);
});

test('aborting pending setup removes its surface and ignores a late response', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const removed = [];
  const chip = { remove: () => removed.push('chip') };
  const root = { dataset: {}, remove: () => removed.push('root') };
  let resolveResponse;
  let requestSignal;
  const controller = new AbortController();
  const pending = initKeySetup({
    documentRef: { getElementById: (id) => id === 'key-setup-chip' ? chip : root },
    signal: controller.signal,
    fetchImpl: (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((resolve) => { resolveResponse = resolve; });
    },
  });
  controller.abort();
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(removed, ['chip', 'root']);
  resolveResponse({ ok: true, json: async () => ({ keys: [] }) });
  assert.equal(await pending, null);
});

/** A small element tree with the attribute selectors the dialog uses. */
function miniDom() {
  const matchSimple = (node, simple) => {
    const tag = simple.match(/^[a-z]+/)?.[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    for (const [, name, , value] of simple.matchAll(/\[([\w-]+)(="([^"]*)")?\]/g)) {
      const actual = node.attributes.get(name);
      if (actual === undefined) return false;
      if (value !== undefined && actual !== value) return false;
    }
    return true;
  };
  const matches = (node, selector) => {
    const parts = selector.trim().split(/\s+/);
    if (!matchSimple(node, parts.at(-1))) return false;
    if (parts.length === 1) return true;
    for (let p = node.parentNode; p; p = p.parentNode)
      if (matchSimple(p, parts[0])) return true;
    return false;
  };
  const all = (root, predicate, out = []) => {
    for (const child of root.children) {
      if (predicate(child)) out.push(child);
      all(child, predicate, out);
    }
    return out;
  };
  const document = Object.assign(new EventTarget(), { activeElement: null });
  const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  document.createElement = (tag) => {
    const classes = new Set();
    const node = Object.assign(new EventTarget(), {
      tagName: tag.toUpperCase(),
      attributes: new Map(),
      children: [],
      parentNode: null,
      textContent: '',
      hidden: false,
      isConnected: true,
      focus() { document.activeElement = this; },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      append(...nodes) { for (const child of nodes) { child.parentNode = this; this.children.push(child); } },
      remove() {},
      querySelector(selector) { return all(this, (n) => matches(n, selector))[0] || null; },
      querySelectorAll(selector) { return all(this, (n) => matches(n, selector)); },
      getClientRects: () => [{}],
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (n) => classes.has(n),
      },
    });
    node.dataset = new Proxy({}, {
      set(_, key, value) { node.attributes.set(`data-${kebab(key)}`, String(value)); return true; },
      get(_, key) { return node.attributes.get(`data-${kebab(String(key))}`); },
    });
    void camel;
    return node;
  };
  return document;
}

test('open({ focusKey }) lands on the named key field after render; a plain open keeps the first field', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const document = miniDom();
  const chip = document.createElement('button');
  const label = document.createElement('span');
  label.setAttribute('data-key-setup-chip-label', '');
  chip.append(label);
  const root = document.createElement('aside');
  const rows = document.createElement('div');
  rows.setAttribute('data-key-setup-rows', '');
  root.append(rows);
  document.getElementById = (id) => (id === 'key-setup-chip' ? chip : id === 'key-setup' ? root : null);
  const priorRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => fn();
  try {
    const keys = [
      { id: 'google-maps', title: 'Google', tier: 'metered', envVars: ['GOOGLE_MAPS_API_KEY'], getUrl: 'https://g', unlocks: 'planet' },
      { id: 'firms', title: 'FIRMS', tier: 'free', envVars: ['FIRMS_MAP_KEY'], getUrl: 'https://f', unlocks: 'fires' },
    ];
    const settings = await initKeySetup({
      documentRef: document,
      fetchImpl: async () => ({ ok: true, json: async () => ({ keys, total: 2, setCount: 0 }) }),
    });
    assert.ok(settings, 'the surface exists under a loopback dev server');
    settings.open({ focusKey: 'firms' });
    assert.equal(document.activeElement?.attributes.get('data-env-var'), 'FIRMS_MAP_KEY');
    settings.close();
    settings.open({ focusKey: 'GOOGLE_MAPS_API_KEY' });
    assert.equal(document.activeElement?.attributes.get('data-env-var'), 'GOOGLE_MAPS_API_KEY', 'an env var name resolves too');
    settings.close();
    settings.open({ focusKey: 'nope"] , *' });
    assert.equal(document.activeElement?.attributes.get('data-env-var'), 'GOOGLE_MAPS_API_KEY', 'an unknown or unsafe key falls back to the first field');
    settings.close();
    settings.open();
    assert.equal(document.activeElement?.attributes.get('data-env-var'), 'GOOGLE_MAPS_API_KEY');
    settings.destroy();
  } finally {
    globalThis.requestAnimationFrame = priorRaf;
  }
});
