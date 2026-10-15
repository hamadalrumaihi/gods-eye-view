import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { expandApplicationHtml } from '../../build/application-html.js';
import { PanelPositionControls } from './panelPositionControls.js';
import { PanelChrome } from './panelChrome.js';
import { bindDisplayControls } from './displayControls.js';

/** Panels with a stored state, a storage with layout and unrelated keys. */
function environment() {
  const saved = {
    document: globalThis.document,
    localStorage: globalThis.localStorage,
  };
  const panel = (id, collapsed) => {
    const classes = new Set(collapsed ? ['collapsed'] : []);
    return {
      id,
      dataset: {},
      style: {},
      classList: {
        contains: (name) => classes.has(name),
        toggle: (name, enabled) =>
          enabled ? classes.add(name) : classes.delete(name),
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
      querySelectorAll: () => [],
      querySelector: () => null,
    };
  };
  const panels = {
    'cctv-panel': panel('cctv-panel', true),
    'data-panel': panel('data-panel', true),
    'scene-panel': panel('scene-panel', false),
    'pp-toggles': panel('pp-toggles', true),
  };
  panels['pp-toggles'].style = { left: '12px', top: '40px', right: 'auto' };
  // Own enumerable keys, as Object.keys(localStorage) enumerates them.
  const storage = {};
  Object.defineProperties(storage, {
    getItem: { value: (key) => (key in storage ? storage[key] : null) },
    setItem: {
      value: (key, value) => {
        storage[key] = String(value);
      },
    },
    removeItem: {
      value: (key) => {
        delete storage[key];
      },
    },
  });
  Object.assign(storage, {
    'godsEyeView.v6.panelCollapsed.cctv-panel': '0',
    'godsEyeView.v6.panelCollapsed.data-panel': '0',
    'godsEyeView.v6.panelCollapsed.scene-panel': '1',
    'godsEyeView.v8.panelPos.pp-toggles': '{"left":12,"top":40}',
    'godsEyeView.v6.panelPos.pp-toggles': '{"left":1,"top":2}',
    'godsEyeView.v8.layoutResetNotified': '1',
    'godsEyeView.detectionAllocation': 'WEIGHTED',
  });
  globalThis.localStorage = storage;
  globalThis.document = {
    getElementById: (id) => panels[id] || null,
    querySelectorAll: (selector) =>
      selector === '[data-default-collapsed]'
        ? Object.values(panels).filter(
            (p) => p.dataset.defaultCollapsed !== undefined,
          )
        : [],
  };
  const controls = new PanelPositionControls({
    syncPanelCollapseButton: () => {},
    layoutRightPanels: () => {},
    syncCctvPanelViewport: () => {},
    showToast: () => {},
  });
  return {
    panels,
    storage,
    controls,
    restore() {
      controls.destroy();
      Object.assign(globalThis, saved);
    },
  };
}

test('a reset forgets every panel layout key across versions and leaves unrelated storage alone', () => {
  const env = environment();
  try {
    for (const id of ['cctv-panel', 'data-panel', 'scene-panel', 'pp-toggles'])
      env.controls._restorePanelCollapsedState(id);
    // Stored choices applied over the markup; the markup default is kept.
    assert.equal(
      env.panels['cctv-panel'].classList.contains('collapsed'),
      false,
    );
    assert.equal(
      env.panels['scene-panel'].classList.contains('collapsed'),
      true,
    );
    assert.equal(env.panels['cctv-panel'].dataset.defaultCollapsed, 'true');
    assert.equal(env.panels['scene-panel'].dataset.defaultCollapsed, 'false');
    // Restoring again must not overwrite the remembered markup default.
    env.controls._restorePanelCollapsedState('cctv-panel');
    assert.equal(env.panels['cctv-panel'].dataset.defaultCollapsed, 'true');

    assert.equal(env.controls.resetStoredLayout(), 5);
    assert.deepEqual(Object.keys(env.storage), [
      'godsEyeView.v8.layoutResetNotified',
      'godsEyeView.detectionAllocation',
    ]);
    assert.deepEqual(env.panels['pp-toggles'].style, {
      left: '',
      top: '',
      right: '',
      bottom: '',
    });
  } finally {
    env.restore();
  }
});

test('Reset panels removes the stored key, returns panels to their defaults in place and toasts', () => {
  const env = environment();
  try {
    for (const id of ['cctv-panel', 'data-panel', 'scene-panel', 'pp-toggles'])
      env.controls._restorePanelCollapsedState(id);
    env.panels['pp-toggles'].classList.remove('collapsed');
    const calls = [];
    const toasts = [];
    let shareSyncs = 0;
    const chrome = {
      _disposed: false,
      _panelPosition: env.controls,
      shareLinkManager: { onPanelStateChange: () => shareSyncs++ },
      _showToast: (message) => toasts.push(message),
      setPanelCollapsed(id, collapsed, options) {
        calls.push([id, collapsed, options]);
        env.panels[id].classList.toggle('collapsed', collapsed);
      },
    };
    PanelChrome.prototype.resetPanelLayout.call(chrome);
    assert.equal(
      'godsEyeView.v6.panelCollapsed.scene-panel' in env.storage,
      false,
    );
    // A panel stored collapsed is expanded again; one stored open returns to
    // its collapsed markup default.
    assert.equal(
      env.panels['scene-panel'].classList.contains('collapsed'),
      false,
    );
    assert.equal(
      env.panels['cctv-panel'].classList.contains('collapsed'),
      true,
    );
    assert.deepEqual(
      calls.map(([id, collapsed]) => [id, collapsed]),
      [
        ['cctv-panel', true],
        ['data-panel', true],
        ['scene-panel', false],
      ],
      'the DISPLAY panel hosting the control is left open',
    );
    for (const [, , options] of calls)
      assert.deepEqual(options, {
        restore: true,
        persist: false,
        syncShare: false,
      });
    assert.equal(
      env.panels['pp-toggles'].classList.contains('collapsed'),
      false,
    );
    assert.equal(
      env.panels['cctv-panel'].dataset.collapsedPreference,
      'default',
    );
    assert.equal(shareSyncs, 1);
    assert.deepEqual(toasts, ['Panel layout reset']);
    chrome._disposed = true;
    PanelChrome.prototype.resetPanelLayout.call(chrome);
    assert.equal(toasts.length, 1, 'a disposed chrome does nothing');
  } finally {
    env.restore();
  }
});

test('the DISPLAY panel carries the Reset panels button and the binding reaches the action', () => {
  const html = expandApplicationHtml(
    readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
  );
  const display = html.slice(
    html.indexOf('id="pp-toggles"'),
    html.indexOf('id="clean-view-exit"'),
  );
  assert.match(
    display,
    /<button class="pp-mode-btn pp-reset-panels-btn" id="reset-panels-btn" type="button"[^>]*>RESET PANELS<\/button>/,
  );
  const button = new EventTarget();
  let resets = 0;
  const control = bindDisplayControls({
    elements: { resetPanelsButton: button },
    actions: { resetPanels: () => resets++ },
  });
  button.dispatchEvent(new Event('click'));
  control.destroy();
  button.dispatchEvent(new Event('click'));
  assert.equal(resets, 1);
});
