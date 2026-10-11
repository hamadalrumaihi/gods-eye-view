import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALLOCATION_TEST_FILES = Object.freeze([
  'src/data/focusAllocations.test.mjs',
  'src/overlays/worldOverlayAllocation.test.mjs',
]);

/** Repository roots that own unit tests; `scripts/` only contributes when it has any. */
export const UNIT_TEST_ROOTS = Object.freeze(['src', 'server', 'scripts']);

/** Whether this runtime matches the one the allocation budgets were calibrated on. */
export function isCalibratedAllocationRuntime(version = process.versions.node) {
  return Number.parseInt(String(version).split('.')[0], 10) === 24;
}

/** Require the runtime on which allocation budgets were calibrated. */
export function assertNode24AllocationRuntime(version = process.versions.node) {
  if (!isCalibratedAllocationRuntime(version)) {
    throw new Error(`Allocation budgets require the calibrated Node 24 runtime; received ${version}`);
  }
  return version;
}

/** Discover repository unit tests in stable path order. */
export function discoverUnitTestFiles(root = process.cwd(), roots = UNIT_TEST_ROOTS) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        files.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  for (const name of roots) {
    const directory = path.join(root, name);
    if (existsSync(directory)) visit(directory);
  }
  return files.sort();
}

/**
 * Split runner options from arguments forwarded to `node --test`.
 * `--filter <glob-or-substring>` is repeatable; `--list` prints the selection.
 */
export function parseRunnerArgs(argv = []) {
  const filters = [];
  const passthrough = [];
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--filter') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--filter requires a glob or substring');
      }
      filters.push(value);
      index += 1;
    } else if (arg.startsWith('--filter=')) {
      filters.push(arg.slice('--filter='.length));
    } else if (arg === '--list') {
      list = true;
    } else {
      passthrough.push(arg);
    }
  }
  return { filters, list, passthrough };
}

/** A filter with glob metacharacters matches the whole path; anything else is a substring. */
export function matchesUnitTestFilter(file, filter) {
  if (!/[*?[]/.test(filter)) return file.includes(filter);
  const pattern = filter
    .split(/(\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${pattern}$`).test(file);
}

/** Keep the files matching any filter; no filters keeps everything. */
export function filterUnitTestFiles(files, filters = []) {
  if (!filters.length) return [...files];
  return files.filter((file) => filters.some((filter) => matchesUnitTestFilter(file, filter)));
}

/**
 * Partition ordinary parallel tests from the two GC-bracketed probes.
 * A filtered selection may omit the probes; a full discovery may not.
 */
export function buildUnitTestPlan(files, { filtered = false } = {}) {
  const known = new Set(files);
  const missingAllocationTests = ALLOCATION_TEST_FILES.filter((file) => !known.has(file));
  if (missingAllocationTests.length && !filtered) {
    throw new Error(`Missing allocation microbenchmarks: ${missingAllocationTests.join(', ')}`);
  }
  const allocationSet = new Set(ALLOCATION_TEST_FILES);
  return {
    parallel: files.filter((file) => !allocationSet.has(file)).sort(),
    serializedAllocations: ALLOCATION_TEST_FILES.filter((file) => known.has(file)),
  };
}

/** Build the isolated Node invocation for one GC-bracketed allocation probe. */
export function allocationTestArgs(file, passthrough = []) {
  if (!ALLOCATION_TEST_FILES.includes(file)) {
    throw new Error(`Not an allocation microbenchmark: ${file}`);
  }
  return ['--expose-gc', '--test', '--test-concurrency=1', ...passthrough, file];
}

function runTests(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runUnitTests(argv = process.argv.slice(2)) {
  const { filters, list, passthrough } = parseRunnerArgs(argv);
  const files = filterUnitTestFiles(discoverUnitTestFiles(), filters);
  if (!files.length) {
    console.error(`[unit] No test files match: ${filters.join(', ')}`);
    return 1;
  }
  if (list) {
    for (const file of files) console.log(file);
    return 0;
  }
  const plan = buildUnitTestPlan(files, { filtered: filters.length > 0 });
  if (plan.parallel.length) {
    const parallelStatus = runTests(['--test', ...passthrough, ...plan.parallel]);
    if (parallelStatus !== 0) return parallelStatus;
  }
  if (!plan.serializedAllocations.length) return 0;

  // The GC-bracketed budgets are calibrated on Node 24 and are meaningless on
  // other allocators. A contributor's suite must stay green on any supported
  // engine (package.json permits >=24), so uncalibrated runtimes skip the
  // probes with a warning. Set GEV_REQUIRE_ALLOCATION_GATE=1 (pinned CI /
  // release batteries) to make an uncalibrated runtime a hard failure.
  if (!isCalibratedAllocationRuntime()) {
    if (process.env.GEV_REQUIRE_ALLOCATION_GATE === '1') {
      assertNode24AllocationRuntime();
    }
    console.warn(
      `[unit] SKIPPED ${plan.serializedAllocations.length} allocation microbenchmarks: `
      + `budgets are calibrated for Node 24, running ${process.versions.node}. `
      + 'Run under Node 24 (or set GEV_REQUIRE_ALLOCATION_GATE=1 to fail instead).',
    );
    return 0;
  }
  for (const file of plan.serializedAllocations) {
    const status = runTests(allocationTestArgs(file, passthrough));
    if (status !== 0) return status;
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) process.exitCode = runUnitTests();
