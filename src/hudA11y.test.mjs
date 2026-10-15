import { expandApplicationHtml } from '../build/application-html.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = expandApplicationHtml(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
const parameters = readFileSync(new URL('./ui/styleParameters.js', import.meta.url), 'utf8');

// Focused markup guards; actual computed names are checked in Chromium.
// Native labels and hidden inputs must not be treated as missing aria-labels.
test('HUD sliders and location search have descriptive explicit names', () => {
  for (const [id, name] of [
    ['scope-feather-slider', 'Scope edge feather'],
    ['bloom-intensity-slider', 'Bloom intensity'],
    ['sharpen-intensity-slider', 'Sharpen intensity'],
    ['location-search', 'Search location by name or coordinates'],
  ]) {
    const input = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(input, `${id} exists`);
    assert.ok(input.includes(`aria-label="${name}"`), `${id} has its descriptive name`);
  }
});

test('the first-run checkbox keeps its native visible label', () => {
  assert.match(html, /<label\b[^>]*class="first-run-suppress"[^>]*>\s*<input type="checkbox" data-first-run-suppress \/>\s*<span>Don't show this again<\/span>\s*<\/label>/);
});

test('generated style sliders use the visible parameter label as their name', () => {
  assert.match(parameters, /label\.textContent\s*=\s*metadata\.label;/);
  assert.match(parameters, /slider\.setAttribute\(['"]aria-label['"],\s*metadata\.label\)/);
});

test('visual preset and display toggles expose aria-pressed that matches their active state', () => {
  const styleButtons = html.match(/<button class="style-btn[^"]*"[^>]*>/g) || [];
  assert.equal(styleButtons.length, 7);
  for (const tag of styleButtons) {
    const active = /class="style-btn active"/.test(tag);
    assert.ok(tag.includes(`aria-pressed="${active}"`), `${tag} reports aria-pressed="${active}"`);
  }
  for (const id of ['hud-toggle', 'clean-view-toggle', 'bloom-toggle', 'sharpen-toggle']) {
    const tag = html.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `${id} exists`);
    assert.ok(tag.includes('aria-pressed="false"'), `${id} ships unpressed`);
    assert.doesNotMatch(tag, /class="[^"]*\bactive\b/, `${id} ships without the active class`);
  }
});

test('the Cockpit HUD can take programmatic focus and both dialogs are modal', () => {
  assert.match(html, /<section id="cockpit-hud"[^>]*tabindex="-1"[^>]*hidden>/);
  assert.match(html, /<aside id="first-run-launcher" role="dialog" aria-modal="true"/);
  assert.match(html, /<aside id="key-setup" role="dialog" aria-modal="true"/);
});
