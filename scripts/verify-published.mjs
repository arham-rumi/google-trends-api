import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXIT_FAILED = 1;
const EXIT_RATE_LIMITED = 2;
const REQUIRED_EXPORTS = [
  'GoogleTrendsClient',
  'GoogleTrendsError',
  'RateLimitError',
  'WidgetNotFoundError',
  'createClient',
  'getResultMetadata',
];

const LIVE_CHECK_NAMES = [
  'autocomplete',
  'trendingNow',
  'interestOverTime',
  'interestByRegion',
  'relatedQueries',
  'relatedTopics',
];

function parsePositiveInteger(value, fallback, fieldName) {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${fieldName} must be a positive integer.`);
  }

  return parsed;
}

function parseNonNegativeInteger(value, fallback, fieldName) {
  if (value === undefined || String(value).trim() === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RangeError(`${fieldName} must be a non-negative integer.`);
  }

  return parsed;
}

function parseCliArguments(argv) {
  let version;
  let startAt;
  let delayMs;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--start-at') {
      startAt = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument.startsWith('--start-at=')) {
      startAt = argument.slice('--start-at='.length);
      continue;
    }

    if (argument === '--delay-ms') {
      delayMs = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument.startsWith('--delay-ms=')) {
      delayMs = argument.slice('--delay-ms='.length);
      continue;
    }

    if (argument.startsWith('-')) {
      throw new RangeError(`Unknown argument: ${argument}`);
    }

    if (version !== undefined) {
      throw new RangeError(`Unexpected positional argument: ${argument}`);
    }

    version = argument;
  }

  if (startAt === undefined && argv.includes('--start-at')) {
    throw new RangeError('--start-at requires a check name.');
  }

  if (delayMs === undefined && argv.includes('--delay-ms')) {
    throw new RangeError('--delay-ms requires a millisecond value.');
  }

  return { version, startAt, delayMs };
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new RangeError(`Invalid boolean value: ${value}`);
}

function npmInvocation(args) {
  const npmExecPath = process.env.npm_execpath?.trim();

  if (npmExecPath) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }

  if (process.platform === 'win32') {
    return { command: 'npm', args, shell: true };
  }

  return { command: 'npm', args };
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
      shell: options.shell ?? false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutMs);

    timeout?.unref();

    if (options.capture) {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    child.on('error', (error) => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      rejectPromise(error);
    });
    child.on('close', (code, signal) => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      resolvePromise({
        code: timedOut ? 124 : (code ?? 1),
        signal: timedOut ? 'TIMEOUT' : signal,
        stdout,
        stderr,
      });
    });
  });
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function makeImportProbe(packageName, mode) {
  const loadStatement =
    mode === 'esm'
      ? `const api = await import(${JSON.stringify(packageName)});`
      : `const api = require(${JSON.stringify(packageName)});`;

  return `${loadStatement}\n\nconst required = ${JSON.stringify(REQUIRED_EXPORTS)};\nconst missing = required.filter((name) => !(name in api));\n\nif (missing.length > 0) {\n  throw new Error(\`Missing ${mode.toUpperCase()} exports: \${missing.join(', ')}\`);\n}\n\nconsole.log(JSON.stringify({ mode: ${JSON.stringify(mode)}, exports: Object.keys(api).sort() }));\n`;
}

function makeLiveProbe(packageName) {
  return `
import assert from 'node:assert/strict';
import {
  RateLimitError,
  createClient,
  getResultMetadata,
} from ${JSON.stringify(packageName)};

const keyword = process.env.GOOGLE_TRENDS_TEST_KEYWORD ?? 'typescript';
const geo = process.env.GOOGLE_TRENDS_TEST_GEO ?? 'US';
const locale = process.env.GOOGLE_TRENDS_TEST_LOCALE ?? 'en-US';
const timeRange = process.env.GOOGLE_TRENDS_TEST_TIME_RANGE ?? 'today 12-m';
const minIntervalMs = Number(process.env.GOOGLE_TRENDS_PUBLISHED_MIN_INTERVAL_MS ?? '4000');
const liveDelayMs = Number(process.env.GOOGLE_TRENDS_PUBLISHED_LIVE_DELAY_MS ?? '10000');
const startAt = process.env.GOOGLE_TRENDS_PUBLISHED_START_AT ?? 'autocomplete';
const checkOrder = ['autocomplete', 'trendingNow', 'interestOverTime', 'interestByRegion', 'relatedQueries', 'relatedTopics'];

if (!Number.isInteger(minIntervalMs) || minIntervalMs <= 0) {
  throw new RangeError('GOOGLE_TRENDS_PUBLISHED_MIN_INTERVAL_MS must be a positive integer.');
}

if (!Number.isInteger(liveDelayMs) || liveDelayMs < 0) {
  throw new RangeError('GOOGLE_TRENDS_PUBLISHED_LIVE_DELAY_MS must be a non-negative integer.');
}

if (!checkOrder.includes(startAt)) {
  throw new RangeError(\`Unknown GOOGLE_TRENDS_PUBLISHED_START_AT value: \${startAt}\`);
}

const startIndex = checkOrder.indexOf(startAt);
const skippedChecks = checkOrder.slice(0, startIndex);

const client = createClient({
  locale,
  timezone: 0,
  retries: 1,
  cache: { enabled: false },
  rateLimit: {
    enabled: true,
    minIntervalMs,
    recovery: false,
  },
});

function verifyMetadata(result) {
  const metadata = getResultMetadata(result);
  assert.deepEqual(metadata, { source: 'network', stale: false });
  return metadata;
}

function finiteNormalizedValue(value, label) {
  assert.equal(typeof value, 'number', \`\${label} must be numeric.\`);
  assert.ok(Number.isFinite(value), \`\${label} must be finite.\`);
  assert.ok(value >= 0 && value <= 100, \`\${label} must be between 0 and 100.\`);
}

const checks = [];
let activeCheck = null;
let executedCheckCount = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function check(name, operation, verify) {
  if (checkOrder.indexOf(name) < startIndex) {
    return;
  }

  if (executedCheckCount > 0 && liveDelayMs > 0) {
    await sleep(liveDelayMs);
  }

  activeCheck = name;
  const startedAt = Date.now();
  const result = await operation();
  const data = verify(result);
  checks.push({
    name,
    status: 'passed',
    durationMs: Date.now() - startedAt,
    data,
  });
  executedCheckCount += 1;
  activeCheck = null;
}

try {
  await check(
    'autocomplete',
    () => client.autocomplete({ keyword, limit: 5 }),
    (result) => {
      assert.equal(result.query, keyword);
      assert.ok(Array.isArray(result.suggestions));
      assert.ok(result.suggestions.length > 0, 'Autocomplete returned no suggestions.');
      assert.ok(result.suggestions.length <= 5, 'Autocomplete ignored the requested limit.');
      verifyMetadata(result);
      return {
        count: result.suggestions.length,
        sample: result.suggestions.slice(0, 2),
      };
    },
  );

  await check(
    'trendingNow',
    () => client.trendingNow({ geo, limit: 5 }),
    (result) => {
      assert.equal(result.geo, geo);
      assert.ok(Array.isArray(result.trends));
      assert.ok(result.trends.length > 0, 'Trending Now returned no trends.');
      assert.ok(result.trends.length <= 5, 'Trending Now ignored the requested limit.');
      assert.ok(result.trends.every((item) => item.publishedAt instanceof Date));
      verifyMetadata(result);
      return {
        count: result.trends.length,
        sample: result.trends.slice(0, 2).map((item) => ({
          title: item.title,
          approxTraffic: item.approxTraffic,
          publishedAt: item.publishedAt.toISOString(),
        })),
      };
    },
  );

  await check(
    'interestOverTime',
    () => client.interestOverTime({ keywords: [keyword], geo, timeRange: 'today 3-m' }),
    (result) => {
      assert.ok(Array.isArray(result.timeline));
      assert.ok(result.timeline.length > 0, 'Interest Over Time returned no points.');
      assert.ok(Array.isArray(result.averages));
      assert.ok(
        result.averages.length === 0 || result.averages.length === 1,
        'Interest Over Time returned an unexpected averages shape.',
      );
      if (result.averages.length === 1) {
        assert.equal(result.averages[0]?.keyword, keyword);
        finiteNormalizedValue(result.averages[0]?.value, 'interestOverTime.average');
      }
      result.timeline.forEach((point, pointIndex) => {
        assert.ok(point.date instanceof Date, \`timeline[\${pointIndex}].date is not a Date.\`);
        assert.equal(point.values.length, 1);
        assert.equal(point.values[0]?.keyword, keyword);
        finiteNormalizedValue(point.values[0]?.value, \`timeline[\${pointIndex}].value\`);
      });
      verifyMetadata(result);
      return {
        points: result.timeline.length,
        first: result.timeline[0]?.date.toISOString(),
        latest: result.timeline.at(-1)?.date.toISOString(),
        average: result.averages[0]?.value ?? null,
        averageProvidedByGoogle: result.averages.length === 1,
      };
    },
  );

  await check(
    'interestByRegion',
    () => client.interestByRegion({ keywords: [keyword], geo, timeRange, resolution: 'REGION' }),
    (result) => {
      assert.ok(Array.isArray(result.regions));
      assert.ok(result.regions.length > 0, 'Interest By Region returned no regions.');
      result.regions.forEach((region, regionIndex) => {
        assert.equal(region.values.length, 1);
        assert.equal(region.values[0]?.keyword, keyword);
        finiteNormalizedValue(region.values[0]?.value, \`regions[\${regionIndex}].value\`);
      });
      verifyMetadata(result);
      return {
        count: result.regions.length,
        sample: result.regions.slice(0, 3).map((region) => ({
          geoName: region.geoName,
          geoCode: region.geoCode,
          value: region.values[0]?.value,
        })),
      };
    },
  );

  await check(
    'relatedQueries',
    () => client.relatedQueries({ keywords: [keyword], geo, timeRange }),
    (result) => {
      assert.equal(result.length, 1);
      assert.equal(result[0]?.keyword, keyword);
      assert.ok(Array.isArray(result[0]?.top));
      assert.ok(Array.isArray(result[0]?.rising));
      verifyMetadata(result);
      return {
        topCount: result[0]?.top.length ?? 0,
        risingCount: result[0]?.rising.length ?? 0,
        topSample: result[0]?.top.slice(0, 2) ?? [],
      };
    },
  );

  await check(
    'relatedTopics',
    () => client.relatedTopics({ keywords: [keyword], geo, timeRange }),
    (result) => {
      assert.equal(result.length, 1);
      assert.equal(result[0]?.keyword, keyword);
      assert.ok(Array.isArray(result[0]?.top));
      assert.ok(Array.isArray(result[0]?.rising));
      verifyMetadata(result);
      return {
        topCount: result[0]?.top.length ?? 0,
        risingCount: result[0]?.rising.length ?? 0,
        topSample: result[0]?.top.slice(0, 2) ?? [],
      };
    },
  );

  console.log(JSON.stringify({ status: 'passed', keyword, geo, startAt, liveDelayMs, skippedChecks, checks }, null, 2));
} catch (error) {
  const rateLimited = error instanceof RateLimitError || error?.name === 'RateLimitError';
  console.error(
    JSON.stringify(
      {
        status: rateLimited ? 'rate-limited' : 'failed',
        keyword,
        geo,
        startAt,
        liveDelayMs,
        skippedChecks,
        checks,
        failedCheck: activeCheck,
        error: {
          name: error?.name ?? 'Error',
          message: error?.message ?? String(error),
          ...(typeof error?.url === 'string' ? { url: error.url } : {}),
        },
      },
      null,
      2,
    ),
  );
  process.exitCode = rateLimited ? ${EXIT_RATE_LIMITED} : ${EXIT_FAILED};
}
`;
}

const startedAt = new Date();
const projectRoot = resolve(process.cwd());
const localPackage = await readJson(join(projectRoot, 'package.json'));
const packageName = process.env.GOOGLE_TRENDS_PUBLISHED_PACKAGE?.trim() || localPackage.name;
const cli = parseCliArguments(process.argv.slice(2));
const versionArgument = cli.version?.trim();
const targetVersion =
  versionArgument || process.env.GOOGLE_TRENDS_PUBLISHED_VERSION?.trim() || localPackage.version;
const liveStartAt =
  cli.startAt?.trim() || process.env.GOOGLE_TRENDS_PUBLISHED_START_AT?.trim() || 'autocomplete';
const liveDelayMs = parseNonNegativeInteger(
  cli.delayMs ?? process.env.GOOGLE_TRENDS_PUBLISHED_LIVE_DELAY_MS,
  10_000,
  'live delay',
);

if (!LIVE_CHECK_NAMES.includes(liveStartAt)) {
  throw new RangeError(
    `--start-at must be one of: ${LIVE_CHECK_NAMES.join(', ')}. Received: ${liveStartAt}`,
  );
}
const installSpec =
  process.env.GOOGLE_TRENDS_PUBLISHED_SPEC?.trim() || `${packageName}@${targetVersion}`;
const npmRegistry = process.env.GOOGLE_TRENDS_NPM_REGISTRY?.trim();
const keepDirectory = parseBoolean(process.env.GOOGLE_TRENDS_KEEP_PUBLISHED_TEST_DIR, false);
const skipLive = parseBoolean(process.env.GOOGLE_TRENDS_PUBLISHED_SKIP_LIVE, false);
const installTimeoutMs = parsePositiveInteger(
  process.env.GOOGLE_TRENDS_PUBLISHED_INSTALL_TIMEOUT_MS,
  120_000,
  'GOOGLE_TRENDS_PUBLISHED_INSTALL_TIMEOUT_MS',
);

assert.equal(typeof packageName, 'string');
assert.ok(packageName.length > 0, 'Published package name cannot be empty.');
assert.equal(typeof targetVersion, 'string');
assert.ok(targetVersion.length > 0, 'Published package version cannot be empty.');

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'google-trends-api-published-'));
const installedPackageDirectory = join(
  temporaryDirectory,
  'node_modules',
  ...packageName.split('/'),
);

let finalExitCode = 0;

try {
  await writeFile(
    join(temporaryDirectory, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  );

  const installArgs = [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--save-exact',
    installSpec,
  ];

  if (npmRegistry !== undefined && npmRegistry.length > 0) {
    installArgs.push(`--registry=${npmRegistry}`);
  }

  console.log(`Installing ${installSpec} into a clean temporary project...`);

  const npmInstall = npmInvocation(installArgs);
  const install = await run(npmInstall.command, npmInstall.args, {
    cwd: temporaryDirectory,
    timeoutMs: installTimeoutMs,
    shell: npmInstall.shell,
  });

  if (install.code !== 0) {
    throw new Error(
      install.code === 124
        ? `npm install exceeded ${installTimeoutMs} ms.`
        : `npm install exited with code ${install.code}${install.signal ? ` (${install.signal})` : ''}.`,
    );
  }

  const installedPackageJsonPath = join(installedPackageDirectory, 'package.json');
  const installedPackage = await readJson(installedPackageJsonPath);

  assert.equal(installedPackage.name, packageName, 'Installed package name does not match target.');
  assert.equal(
    installedPackage.version,
    targetVersion,
    `Registry installed ${installedPackage.version} instead of requested ${targetVersion}.`,
  );

  const layout = {
    esm: await pathExists(join(installedPackageDirectory, 'dist', 'index.mjs')),
    cjs: await pathExists(join(installedPackageDirectory, 'dist', 'index.cjs')),
    declarations: await pathExists(join(installedPackageDirectory, 'dist', 'index.d.mts')),
    sourceExcluded: !(await pathExists(join(installedPackageDirectory, 'src'))),
    repositoryScriptsExcluded: !(await pathExists(join(installedPackageDirectory, 'scripts'))),
  };

  assert.ok(layout.esm, 'Published package is missing dist/index.mjs.');
  assert.ok(layout.cjs, 'Published package is missing dist/index.cjs.');
  assert.ok(layout.declarations, 'Published package is missing dist/index.d.mts.');
  assert.ok(layout.sourceExcluded, 'Published package unexpectedly contains src/.');
  assert.ok(layout.repositoryScriptsExcluded, 'Published package unexpectedly contains scripts/.');

  const esmProbe = join(temporaryDirectory, 'probe-esm.mjs');
  const cjsProbe = join(temporaryDirectory, 'probe-cjs.cjs');
  const liveProbe = join(temporaryDirectory, 'probe-live.mjs');

  await writeFile(esmProbe, makeImportProbe(packageName, 'esm'));
  await writeFile(cjsProbe, makeImportProbe(packageName, 'cjs'));
  await writeFile(liveProbe, makeLiveProbe(packageName));

  const esmResult = await run(process.execPath, [esmProbe], {
    cwd: temporaryDirectory,
    capture: true,
  });
  assert.equal(esmResult.code, 0, `ESM import failed:\n${esmResult.stderr || esmResult.stdout}`);

  const cjsResult = await run(process.execPath, [cjsProbe], {
    cwd: temporaryDirectory,
    capture: true,
  });
  assert.equal(
    cjsResult.code,
    0,
    `CommonJS require failed:\n${cjsResult.stderr || cjsResult.stdout}`,
  );

  let liveResult = { code: 0, stdout: '', stderr: '' };

  if (!skipLive) {
    console.log('Running live Google Trends requests through the installed registry package...');
    liveResult = await run(process.execPath, [liveProbe], {
      cwd: temporaryDirectory,
      capture: true,
      env: {
        ...process.env,
        GOOGLE_TRENDS_PUBLISHED_START_AT: liveStartAt,
        GOOGLE_TRENDS_PUBLISHED_LIVE_DELAY_MS: String(liveDelayMs),
      },
    });

    const output = `${liveResult.stdout}${liveResult.stderr}`.trim();
    if (output.length > 0) {
      console.log(output);
    }

    if (liveResult.code === EXIT_RATE_LIMITED) {
      finalExitCode = EXIT_RATE_LIMITED;
    } else if (liveResult.code !== 0) {
      finalExitCode = EXIT_FAILED;
    }
  }

  const completedAt = new Date();
  const summary = {
    status:
      finalExitCode === 0
        ? 'passed'
        : finalExitCode === EXIT_RATE_LIMITED
          ? 'rate-limited'
          : 'failed',
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    package: {
      name: packageName,
      requestedVersion: targetVersion,
      installedVersion: installedPackage.version,
      installSpec,
      registry: npmRegistry || 'npm configured/default registry',
    },
    verification: {
      cleanTemporaryInstall: true,
      exactVersionInstalled: true,
      esmImportPassed: true,
      commonJsRequirePassed: true,
      publishedPackageLayoutValid: true,
      liveRequestsRun: !skipLive,
      liveRequestsPassed: skipLive ? null : finalExitCode === 0,
      liveStartAt: skipLive ? null : liveStartAt,
      liveDelayMs: skipLive ? null : liveDelayMs,
    },
    layout,
    temporaryDirectory: keepDirectory ? temporaryDirectory : undefined,
  };

  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  finalExitCode = EXIT_FAILED;
  console.error(
    JSON.stringify(
      {
        status: 'failed',
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        package: { name: packageName, requestedVersion: targetVersion },
        temporaryDirectory: keepDirectory ? temporaryDirectory : undefined,
        error: {
          name: error?.name ?? 'Error',
          message: error?.message ?? String(error),
        },
      },
      null,
      2,
    ),
  );
} finally {
  if (!keepDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

process.exitCode = finalExitCode;
