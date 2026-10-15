import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

/** Split a Dependabot config into its `- package-ecosystem:` entries. */
function dependabotEntries(config) {
  return config
    .split(/\n(?=  - package-ecosystem:)/)
    .filter((block) => block.trimStart().startsWith('- package-ecosystem:'));
}

test('dependabot checks npm weekly in one grouped minor/patch PR and actions monthly', () => {
  const config = read('.github/dependabot.yml');
  assert.match(config, /^version: 2\n/);
  const entries = dependabotEntries(config);
  assert.deepEqual(
    entries.map((entry) => entry.match(/package-ecosystem: (\S+)/)[1]),
    ['npm', 'github-actions'],
  );
  const [npm, actions] = entries;
  assert.match(npm, /interval: weekly/);
  assert.match(npm, /groups:\n\s+\S+:\n\s+update-types:\n\s+- minor\n\s+- patch/);
  assert.match(actions, /interval: monthly/);
  for (const entry of entries) {
    assert.match(entry, /directory: \//);
    const limit = Number(entry.match(/open-pull-requests-limit: (\d+)/)?.[1]);
    assert.ok(limit >= 1 && limit <= 5, `a modest PR limit, got ${limit}`);
  }
});

test('workflow actions stay SHA-pinned with a version comment for Dependabot to update', () => {
  const uses = [...read('.github/workflows/ci.yml').matchAll(/uses: (\S+)(.*)/g)];
  assert.ok(uses.length >= 2);
  for (const [, action, trailer] of uses) {
    assert.match(action, /@[0-9a-f]{40}$/, `${action} is pinned to a commit`);
    assert.match(trailer, /# v\d+/, `${action} names the pinned version`);
  }
});
