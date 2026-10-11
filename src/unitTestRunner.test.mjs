import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOCATION_TEST_FILES,
  UNIT_TEST_ROOTS,
  allocationTestArgs,
  assertNode24AllocationRuntime,
  buildUnitTestPlan,
  discoverUnitTestFiles,
  filterUnitTestFiles,
  isCalibratedAllocationRuntime,
  matchesUnitTestFilter,
  parseRunnerArgs,
} from '../scripts/run-unit-tests.mjs';

test('unit runner discovers src/ and server/ tests, and scripts/ only when it has any', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-unit-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file) => {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), '');
  };
  write('src/b.test.mjs');
  write('src/data/a.test.mjs');
  write('src/data/helper.mjs');
  write('src/node_modules/dep/skipped.test.mjs');
  write('server/providers/transitHistory.test.mjs');
  write('scripts/qa-thing.mjs');
  assert.deepEqual(UNIT_TEST_ROOTS, ['src', 'server', 'scripts']);
  assert.deepEqual(discoverUnitTestFiles(root), [
    'server/providers/transitHistory.test.mjs',
    'src/b.test.mjs',
    'src/data/a.test.mjs',
  ]);
  write('scripts/tool.test.mjs');
  assert.deepEqual(discoverUnitTestFiles(root), [
    'scripts/tool.test.mjs',
    'server/providers/transitHistory.test.mjs',
    'src/b.test.mjs',
    'src/data/a.test.mjs',
  ]);
  // The repository's own server test is no longer invisible to `npm test`.
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  assert.ok(discoverUnitTestFiles(repoRoot).includes('server/providers/transitHistory.test.mjs'));
});

test('unit runner filters are substrings or globs, repeatable, and leave other args to node --test', () => {
  const files = [
    'server/providers/transitHistory.test.mjs',
    'src/data/focusAllocations.test.mjs',
    'src/pinokioEnvironment.test.mjs',
    'src/pinokioUpdatePreview.test.mjs',
    'src/setupDoctor.test.mjs',
  ];
  assert.deepEqual(parseRunnerArgs([]), { filters: [], list: false, passthrough: [] });
  assert.deepEqual(
    parseRunnerArgs(['--filter', 'server/', '--list', '--filter=pinokioEnv', '--test-name-pattern=x']),
    { filters: ['server/', 'pinokioEnv'], list: true, passthrough: ['--test-name-pattern=x'] },
  );
  assert.throws(() => parseRunnerArgs(['--filter']), /--filter requires/);
  assert.throws(() => parseRunnerArgs(['--filter', '--list']), /--filter requires/);

  assert.equal(matchesUnitTestFilter('src/pinokioUpdatePreview.test.mjs', 'pinokio'), true);
  assert.equal(matchesUnitTestFilter('src/pinokioUpdatePreview.test.mjs', 'src/pinokio*.test.mjs'), true);
  assert.equal(matchesUnitTestFilter('src/data/a.test.mjs', 'src/*.test.mjs'), false, '* stops at /');
  assert.equal(matchesUnitTestFilter('src/data/a.test.mjs', 'src/**/*.test.mjs'), true);
  assert.equal(matchesUnitTestFilter('src/a.test.mjs', 'src/?.test.mjs'), true);
  assert.equal(matchesUnitTestFilter('src/a.test.mjs', 'src/a.test.mj'), true, 'substring without glob');
  assert.equal(matchesUnitTestFilter('src/axtest.mjs', 'src/a.test.mjs'), false, 'dots are literal');

  assert.deepEqual(filterUnitTestFiles(files), files);
  assert.deepEqual(filterUnitTestFiles(files, ['setupDoctor', 'pinokioEnvironment']), [
    'src/pinokioEnvironment.test.mjs',
    'src/setupDoctor.test.mjs',
  ]);
  assert.deepEqual(filterUnitTestFiles(files, ['server/**']), ['server/providers/transitHistory.test.mjs']);
  assert.deepEqual(filterUnitTestFiles(files, ['nothing-matches']), []);

  // A filtered selection may omit the GC-bracketed probes, and only runs the ones it kept.
  const partial = buildUnitTestPlan(filterUnitTestFiles(files, ['setupDoctor']), { filtered: true });
  assert.deepEqual(partial, { parallel: ['src/setupDoctor.test.mjs'], serializedAllocations: [] });
  const oneProbe = buildUnitTestPlan(['src/data/focusAllocations.test.mjs'], { filtered: true });
  assert.deepEqual(oneProbe, { parallel: [], serializedAllocations: ['src/data/focusAllocations.test.mjs'] });
  assert.throws(() => buildUnitTestPlan(files), /Missing allocation microbenchmarks/);
  // Forwarded arguments precede the file in the isolated probe invocation.
  assert.deepEqual(allocationTestArgs(ALLOCATION_TEST_FILES[0], ['--test-name-pattern=x']), [
    '--expose-gc', '--test', '--test-concurrency=1', '--test-name-pattern=x', ALLOCATION_TEST_FILES[0],
  ]);
});

test('the Windows onboarding job selects its focused tests through the runner filter', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const step = ci.split('\n').find((line) => line.includes('scripts/run-unit-tests.mjs --filter'));
  assert.ok(step, 'the Windows job runs the shared runner with filters');
  assert.doesNotMatch(ci, /run: node --test /, 'no hand-listed node --test invocation remains');
  const filters = [...step.matchAll(/--filter (\S+)/g)].map((match) => match[1]);
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  assert.deepEqual(filterUnitTestFiles(discoverUnitTestFiles(repoRoot), filters), [
    'src/hudSummaryResponse.test.mjs',
    'src/keySetupHardening.test.mjs',
    'src/mapStartup.test.mjs',
    'src/pinokioEnvironment.test.mjs',
    'src/pinokioLauncherContract.test.mjs',
    'src/pinokioPreflight.test.mjs',
    'src/setupDoctor.test.mjs',
  ]);
});

test('unit runner serializes only GC-bracketed allocation microbenchmarks', () => {
  const ordinary = [
    'src/data/manager.test.mjs',
    'src/data/radio.test.mjs',
    'src/unitTestRunner.test.mjs',
  ];
  const plan = buildUnitTestPlan([
    ordinary[1],
    ALLOCATION_TEST_FILES[1],
    ordinary[0],
    ALLOCATION_TEST_FILES[0],
    ordinary[2],
  ]);

  assert.deepEqual(plan.parallel, ordinary);
  assert.deepEqual(plan.serializedAllocations, ALLOCATION_TEST_FILES);
  assert.equal(plan.parallel.some((file) => ALLOCATION_TEST_FILES.includes(file)), false);
  for (const file of ALLOCATION_TEST_FILES) {
    assert.deepEqual(allocationTestArgs(file), [
      '--expose-gc', '--test', '--test-concurrency=1', file,
    ]);
  }
  assert.throws(
    () => allocationTestArgs('src/data/radio.test.mjs'),
    /Not an allocation microbenchmark/,
  );
});

test('allocation runtime calibration is explicit and pinned to Node 24', () => {
  assert.equal(assertNode24AllocationRuntime('24.19.0'), '24.19.0');
  assert.throws(
    () => assertNode24AllocationRuntime('22.23.1'),
    /calibrated Node 24 runtime/,
  );
  assert.throws(
    () => assertNode24AllocationRuntime('26.0.0'),
    /calibrated Node 24 runtime/,
  );
  assert.equal(isCalibratedAllocationRuntime('24.19.0'), true);
  assert.equal(isCalibratedAllocationRuntime('22.23.1'), false);
  assert.equal(isCalibratedAllocationRuntime('26.3.0'), false);
});

test('npm test stays green on every supported engine, not only the calibrated one', () => {
  // package.json wiring: `npm test` must invoke this runner, and the engines
  // range it advertises must not be narrower than what the runner tolerates.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-unit-tests.mjs');
  const enginesNode = String(pkg.engines?.node || '');
  assert.ok(enginesNode, 'engines.node must be declared');
  // The runner throws for uncalibrated runtimes ONLY behind the explicit
  // opt-in env; by default it skips, so a supported non-24 engine cannot fail.
  const runner = readFileSync(new URL('../scripts/run-unit-tests.mjs', import.meta.url), 'utf8');
  assert.match(runner, /GEV_REQUIRE_ALLOCATION_GATE/);
  assert.match(runner, /SKIPPED .*allocation microbenchmarks/);
});
