import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandApplicationHtml, APPLICATION_TEMPLATES } from '../../build/application-html.js';

test('the standalone document expands every component once and preserves unique element ids', () => {
  const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const html = expandApplicationHtml(source);
  assert.equal([...source.matchAll(/gev:template /g)].length, APPLICATION_TEMPLATES.length);
  assert.doesNotMatch(html, /gev:template/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /id="cesiumContainer"/);
  assert.match(html, /type="module" src="\/src\/main.js"/);
});

test('component selection includes only requested markup and refuses filesystem traversal', () => {
  const html = expandApplicationHtml('<!-- gev:template welcome -->\n');
  assert.match(html, /id="first-run-launcher"/);
  assert.doesNotMatch(html, /id="cesiumContainer"/);
  assert.throws(() => expandApplicationHtml('<!-- gev:template ../../.env -->'), /Unknown application template/);
});

test('the viewport meta opts into the full screen so the safe-area inset rules apply', () => {
  const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const meta = source.match(/<meta name="viewport" content="([^"]+)" \/>/)?.[1];
  assert.ok(meta, 'the viewport meta exists');
  assert.ok(meta.includes('width=device-width'));
  assert.ok(meta.includes('viewport-fit=cover'), 'env(safe-area-inset-*) is inert without viewport-fit=cover');
  for (const sheet of ['responsive.css', 'cockpit.css']) {
    const css = readFileSync(new URL(`../ui/styles/${sheet}`, import.meta.url), 'utf8');
    assert.match(css, /env\(safe-area-inset-/, `${sheet} still relies on the safe-area insets`);
  }
});
