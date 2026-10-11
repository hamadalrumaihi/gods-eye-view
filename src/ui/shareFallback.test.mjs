import assert from 'node:assert/strict';
import test from 'node:test';
import { createShareFallback } from './shareFallback.js';
import { shellMethod } from '../testSupport/readShellSource.mjs';
import { ShareLinkManager } from '../sharelink.js';

/** A popover root with the three parts the markup carries. */
function popover({ execCommand } = {}) {
  const document = { activeElement: null, execCommand };
  const node = (extra = {}) =>
    Object.assign(new EventTarget(), {
      ownerDocument: document,
      isConnected: true,
      focus() {
        document.activeElement = this;
      },
      ...extra,
    });
  const input = node({
    value: '',
    selected: 0,
    select() {
      this.selected += 1;
    },
  });
  const copy = node();
  const close = node();
  const parts = {
    '[data-share-fallback-url]': input,
    '[data-share-fallback-copy]': copy,
    '[data-share-fallback-close]': close,
  };
  const root = node({
    hidden: true,
    querySelector: (selector) => parts[selector] || null,
  });
  const opener = node();
  const toasts = [];
  return { document, root, input, copy, close, opener, toasts };
}

test('the popover shows the URL pre-selected in a focused read-only field and Escape returns focus', () => {
  const f = popover();
  f.opener.focus();
  const fallback = createShareFallback({
    root: f.root,
    documentRef: f.document,
    showToast: (message) => f.toasts.push(message),
  });
  fallback.show('https://example.test/#lat=1');
  assert.equal(f.root.hidden, false);
  assert.equal(f.input.value, 'https://example.test/#lat=1');
  assert.equal(f.document.activeElement, f.input);
  assert.equal(f.input.selected, 1);
  const escape = Object.assign(new Event('keydown', { cancelable: true }), {
    key: 'Escape',
  });
  f.root.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(f.root.hidden, true);
  assert.equal(f.document.activeElement, f.opener);
  fallback.destroy();
});

test('COPY retries through execCommand and reports the outcome; CLOSE dismisses', () => {
  let commands = [];
  const f = popover({
    execCommand: (name) => {
      commands.push(name);
      return commands.length === 1;
    },
  });
  const fallback = createShareFallback({
    root: f.root,
    documentRef: f.document,
    showToast: (message) => f.toasts.push(message),
  });
  fallback.show('https://example.test/#a');
  f.copy.dispatchEvent(new Event('click'));
  assert.deepEqual(commands, ['copy']);
  assert.deepEqual(f.toasts, ['Link copied!']);
  f.copy.dispatchEvent(new Event('click'));
  assert.equal(f.toasts.at(-1), 'Press Ctrl/Cmd+C to copy the link');
  assert.equal(f.input.selected, 3, 'each copy re-selects the link');
  f.close.dispatchEvent(new Event('click'));
  assert.equal(f.root.hidden, true);
  fallback.destroy();
  fallback.show('https://example.test/#b');
  assert.equal(f.root.hidden, true, 'a destroyed popover never reopens');
  f.copy.dispatchEvent(new Event('click'));
  assert.equal(commands.length, 2, 'destroyed listeners are gone');
});

test('a missing root or field is inert rather than a crash', () => {
  for (const root of [null, { querySelector: () => null, ownerDocument: {} }]) {
    const fallback = createShareFallback({ root });
    fallback.show('x');
    fallback.hide();
    assert.equal(fallback.isOpen(), false);
    fallback.destroy();
  }
});

test('with no clipboard the share action offers the built link in the popover instead of a dead toast', async () => {
  const saved = {
    window: globalThis.window,
    history: globalThis.history,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  globalThis.window = {
    location: { hash: '', href: 'http://localhost/' },
  };
  globalThis.history = { replaceState() {} };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: undefined,
  });
  try {
    const viewer = {
      camera: {
        changed: { addEventListener() {} },
        positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
        heading: 0,
        pitch: -Math.PI / 2,
        roll: 0,
      },
    };
    const shareLinkManager = new ShareLinkManager(viewer);
    const f = popover();
    const toasts = [];
    let onClick;
    const shell = {
      _disposed: false,
      _shareBtn: {},
      _shareFallbackRoot: f.root,
      shareLinkManager,
      _lifetime: {
        listen: (_target, _type, listener) => {
          onClick = listener;
        },
      },
      _showToast: (message) => toasts.push(message),
    };
    shellMethod('_initShareButton').call(shell);
    await onClick();
    assert.equal(f.root.hidden, false, 'the popover opens');
    assert.match(
      f.input.value,
      /^http:\/\/localhost\/#v=2&lat=0\.0000&lon=0\.0000/,
    );
    assert.match(f.input.value, /&at=\d+/, 'the link carries the copy time');
    assert.equal(f.document.activeElement, f.input);
    assert.deepEqual(toasts, [], 'no "Copy failed" toast for a usable link');

    // A later successful copy closes the popover and keeps the toast.
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async () => {} } },
    });
    await onClick();
    assert.equal(f.root.hidden, true);
    assert.deepEqual(toasts, ['Link copied!']);
    shell._shareFallback.destroy();
  } finally {
    globalThis.window = saved.window;
    globalThis.history = saved.history;
    if (saved.navigator)
      Object.defineProperty(globalThis, 'navigator', saved.navigator);
    else delete globalThis.navigator;
  }
});
