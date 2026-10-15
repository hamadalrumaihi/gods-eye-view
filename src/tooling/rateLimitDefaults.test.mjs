import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RATE_LIMIT_DEFAULTS,
  makeOptInRateLimiter,
  resolveRateLimitPerMin,
} from '../../server/providers/common/rate-limit.js';
import { PINOKIO_CONFIG_FIELDS } from '../../scripts/pinokio-environment.mjs';

test('an unset limit uses the documented default; 0 or off opts out; a number is used as given', () => {
  for (const unset of [undefined, null, '', '   ']) {
    assert.equal(
      resolveRateLimitPerMin(unset, 30),
      30,
      `unset ${JSON.stringify(unset)}`,
    );
  }
  for (const off of ['0', ' 0 ', 'off', 'OFF', 'Off']) {
    assert.equal(resolveRateLimitPerMin(off, 30), null, `opt-out ${off}`);
  }
  assert.equal(resolveRateLimitPerMin('45', 30), 45);
  assert.equal(resolveRateLimitPerMin('12.7', 30), 12);
  // Not a deliberate opt-out: the cap stays rather than silently vanishing.
  for (const garbage of ['-3', 'abc', 'NaN', 'Infinity', 'none']) {
    assert.equal(resolveRateLimitPerMin(garbage, 30), 30, `garbage ${garbage}`);
  }
  // With no default supplied the historical opt-in semantics remain.
  assert.equal(resolveRateLimitPerMin(undefined), null);
  assert.equal(resolveRateLimitPerMin('5'), 5);
});

test('the defaults match what the Pinokio launcher writes', () => {
  assert.deepEqual(RATE_LIMIT_DEFAULTS, {
    OPENAI_PER_MIN: 30,
    GOOGLE_PER_MIN: 120,
  });
  const launcher = readFileSync(
    new URL('../../scripts/pinokio-environment.mjs', import.meta.url),
    'utf8',
  );
  assert.match(launcher, /GEV_RATELIMIT_OPENAI_PER_MIN: '30'/);
  assert.match(launcher, /GEV_RATELIMIT_GOOGLE_PER_MIN: '120'/);
  assert.ok(PINOKIO_CONFIG_FIELDS.includes('GEV_RATELIMIT_OPENAI_PER_MIN'));
  const example = readFileSync(
    new URL('../../.env.example', import.meta.url),
    'utf8',
  );
  assert.match(example, /DEFAULT IS 30 PER MINUTE/);
  assert.match(example, /DEFAULT IS 120 PER MINUTE/);
  assert.doesNotMatch(example, /DEFAULT IS UNLIMITED/);
});

test('a limiter built from an unset value enforces the default window', () => {
  const allow = makeOptInRateLimiter(undefined, 2);
  assert.equal(typeof allow, 'function');
  assert.equal(allow('peer'), true);
  assert.equal(allow('peer'), true);
  assert.equal(
    allow('peer'),
    false,
    'the third request in the minute is refused',
  );
  assert.equal(allow('other'), true, 'another peer has its own window');
  assert.equal(makeOptInRateLimiter('off', 2), null);
  assert.equal(makeOptInRateLimiter('0', 2), null);
  assert.equal(makeOptInRateLimiter('', undefined), null);
});
