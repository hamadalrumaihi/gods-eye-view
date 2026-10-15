import assert from 'node:assert/strict';
import test from 'node:test';
import { DisplayBindings } from './displayBindings.js';

/** A document that dispatches keyboard input and resolves the Data Layers panel. */
function environment({ collapsed = false } = {}) {
  const original = globalThis.document;
  const listeners = new Map();
  const classes = new Set(['panel-collapsible', 'active']);
  if (collapsed) classes.add('collapsed');
  const panel = {
    id: 'data-panel',
    classList: {
      contains: (name) => classes.has(name),
      toggle(name, enabled) {
        if (enabled ?? !classes.has(name)) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  const document = {
    hidden: false,
    getElementById: (id) => (id === 'data-panel' ? panel : null),
    querySelectorAll: () => [],
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  globalThis.document = document;
  const calls = [];
  const bindings = new DisplayBindings({
    viewer: {},
    services: {},
    elements: {},
    operations: {
      setPanelCollapsed: (...args) => {
        calls.push(args);
        panel.classList.toggle('collapsed', args[1]);
      },
    },
    readState: () => ({ _detectionAllocationBtns: [] }),
    claimDetection() {},
  });
  bindings._initUI();
  return {
    panel,
    classes,
    calls,
    bindings,
    press: (key, rest = {}) => {
      for (const listener of [...(listeners.get('keydown') || [])])
        listener({ key, target: {}, ...rest });
    },
    restore() {
      bindings.destroy();
      globalThis.document = original;
    },
  };
}

test('F collapses the Data Layers panel through the panel chrome instead of hiding it', () => {
  const env = environment();
  try {
    env.press('f');
    assert.deepEqual(env.calls, [['data-panel', true, { explicit: true }]]);
    assert.equal(
      env.classes.has('active'),
      true,
      'the panel header must stay visible as the way back',
    );
    env.press('F');
    assert.deepEqual(env.calls.at(-1), [
      'data-panel',
      false,
      { explicit: true },
    ]);
    assert.equal(env.classes.has('active'), true);
  } finally {
    env.restore();
  }
});

test('a collapsed Data Layers panel expands on F, and Cmd+F is left to the browser', () => {
  const env = environment({ collapsed: true });
  try {
    env.press('f', { metaKey: true });
    env.press('f', { ctrlKey: true });
    assert.deepEqual(env.calls, []);
    env.press('f');
    assert.deepEqual(env.calls, [['data-panel', false, { explicit: true }]]);
  } finally {
    env.restore();
  }
});
