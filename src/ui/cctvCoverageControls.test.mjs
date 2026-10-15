import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { expandApplicationHtml } from '../../build/application-html.js';
import { CctvControls } from './cctvControls.js';

/** Three radio options inside one radiogroup, as the panel markup ships them. */
function radiogroup() {
  const document = { activeElement: null };
  const option = (mode) => {
    const classes = new Set();
    const node = Object.assign(new EventTarget(), {
      dataset: { coverageMode: mode },
      attributes: new Map(),
      disabled: false,
      tabIndex: -1,
      focus() {
        document.activeElement = this;
      },
      closest: (selector) =>
        selector === '[data-coverage-mode]' ? node : null,
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      },
      getAttribute(name) {
        return this.attributes.get(name) ?? null;
      },
      classList: {
        toggle: (name, enabled) =>
          enabled ? classes.add(name) : classes.delete(name),
        contains: (name) => classes.has(name),
      },
    });
    return node;
  };
  const options = ['off', 'on', 'viewshed'].map(option);
  const group = Object.assign(new EventTarget(), {
    querySelectorAll: (selector) =>
      selector === '[data-coverage-mode]' ? options : [],
  });
  const patches = [];
  const controls = new CctvControls({
    elements: { _cctvPanel: {}, _cctvCoverageMode: group },
    cctv: {},
    actions: {
      isEnabled: () => true,
      syncViewport() {},
      setPanelCollapsed() {},
      setParams: (params, options) => patches.push([params, options]),
    },
  });
  const dispatch = (target, type, init) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    Object.assign(event, init);
    group.dispatchEvent(event);
    return event;
  };
  const checked = () =>
    options.map((o) => o.getAttribute('aria-checked')).join();
  return { document, options, group, controls, patches, dispatch, checked };
}

test('the three coverage options report the current mode through aria-checked and a roving tabindex', (t) => {
  const f = radiogroup();
  t.after(() => f.controls.destroy());
  f.controls._renderCctvState({ enabled: true, coverageMode: 'viewshed' });
  assert.equal(f.checked(), 'false,false,true');
  assert.deepEqual(
    f.options.map((o) => o.tabIndex),
    [-1, -1, 0],
  );
  assert.deepEqual(
    f.options.map((o) => o.classList.contains('active')),
    [false, false, true],
  );
  assert.deepEqual(
    f.options.map((o) => o.disabled),
    [false, false, false],
  );
  f.controls._renderCctvState({ enabled: true, showCoverage: true });
  assert.equal(f.checked(), 'false,true,false', 'legacy showCoverage is ON');
  f.controls._renderCctvState({ enabled: false, coverageMode: 'on' });
  assert.deepEqual(
    f.options.map((o) => o.disabled),
    [true, true, true],
    'camera layer off disables the group but keeps the mode visible',
  );
  assert.equal(f.checked(), 'false,true,false');
});

test('clicking an option selects that mode; arrows, Home and End move and select', (t) => {
  const f = radiogroup();
  t.after(() => f.controls.destroy());
  f.controls._renderCctvState({ enabled: true, coverageMode: 'off' });
  f.dispatch(f.options[2], 'click');
  assert.deepEqual(f.patches.at(-1), [
    { coverageMode: 'viewshed' },
    { origin: 'user' },
  ]);
  const right = f.dispatch(f.options[2], 'keydown', { key: 'ArrowRight' });
  assert.equal(right.defaultPrevented, true);
  assert.equal(f.document.activeElement, f.options[0], 'wraps to OFF');
  assert.deepEqual(f.patches.at(-1)[0], { coverageMode: 'off' });
  f.dispatch(f.options[0], 'keydown', { key: 'ArrowLeft' });
  assert.deepEqual(f.patches.at(-1)[0], { coverageMode: 'viewshed' });
  f.dispatch(f.options[2], 'keydown', { key: 'Home' });
  assert.deepEqual(f.patches.at(-1)[0], { coverageMode: 'off' });
  f.dispatch(f.options[0], 'keydown', { key: 'End' });
  assert.deepEqual(f.patches.at(-1)[0], { coverageMode: 'viewshed' });
  const other = f.dispatch(f.options[0], 'keydown', { key: 'Enter' });
  assert.equal(other.defaultPrevented, false, 'native activation is untouched');
  const count = f.patches.length;
  f.controls._renderCctvState({ enabled: false, coverageMode: 'off' });
  f.dispatch(f.options[1], 'click');
  f.dispatch(f.options[0], 'keydown', { key: 'ArrowRight' });
  assert.equal(f.patches.length, count, 'a disabled group selects nothing');
});

test('the panel ships the coverage radiogroup in place of the cycling button', () => {
  const html = expandApplicationHtml(
    readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
  );
  assert.doesNotMatch(html, /id="cctv-coverage-btn"/);
  const group = html.match(
    /<div id="cctv-coverage-mode"[^>]*role="radiogroup"[^>]*aria-labelledby="cctv-coverage-label"[^>]*>[\s\S]*?<\/div>/,
  )?.[0];
  assert.ok(group, 'the radiogroup exists');
  assert.match(html, /id="cctv-coverage-label"[^>]*>COVERAGE</);
  const options = [...group.matchAll(/data-coverage-mode="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(options, ['off', 'on', 'viewshed']);
  assert.equal((group.match(/role="radio"/g) || []).length, 3);
  assert.equal((group.match(/aria-checked="true"/g) || []).length, 1);
});
