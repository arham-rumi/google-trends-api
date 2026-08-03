import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const projectRoot = resolve(import.meta.dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });

  if (result.error !== undefined) {
    throw new Error(
      `Could not start command: ${command} ${args.join(' ')}\n${result.error.message}`,
      { cause: result.error },
    );
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(
      `Command failed with exit code ${String(result.status)}: ${command} ${args.join(' ')}\n${output}`,
    );
  }

  return result.stdout.trim();
}

function runNpm(args, options = {}) {
  const npmCliPath = process.env.npm_execpath;

  if (typeof npmCliPath === 'string' && npmCliPath.length > 0) {
    return run(process.execPath, [npmCliPath, ...args], options);
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  return run(npmCommand, args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'google-trends-api-consumer-'));

let tarballPath;

try {
  const packOutput = runNpm(['pack', '--json', '--ignore-scripts']);
  const packResult = JSON.parse(packOutput);

  const isPackEntry = (value) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.filename === 'string' &&
    value.filename.length > 0;

  const packEntries = Array.isArray(packResult)
    ? packResult
    : isPackEntry(packResult)
      ? [packResult]
      : typeof packResult === 'object' && packResult !== null
        ? Object.values(packResult)
        : [];

  const filename = packEntries.find(isPackEntry)?.filename;

  if (typeof filename !== 'string') {
    throw new Error(
      `npm pack did not return a tarball filename. Received: ${JSON.stringify(packResult)}`,
    );
  }

  tarballPath = join(projectRoot, filename);

  await writeFile(
    join(temporaryDirectory, 'package.json'),
    JSON.stringify(
      {
        name: 'google-trends-api-consumer-test',
        private: true,
        type: 'module',
      },
      null,
      2,
    ),
  );

  runNpm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarballPath],
    { cwd: temporaryDirectory },
  );

  await writeFile(
    join(temporaryDirectory, 'esm.mjs'),
    `import { GoogleTrendsClient, createClient } from ${JSON.stringify(packageJson.name)};\n\nconst client = createClient({ retries: 0 });\nif (!(client instanceof GoogleTrendsClient)) {\n  throw new Error('ESM import did not return a GoogleTrendsClient.');\n}\nconsole.log('ESM package import passed.');\n`,
  );

  await writeFile(
    join(temporaryDirectory, 'cjs.cjs'),
    `const { GoogleTrendsClient, createClient } = require(${JSON.stringify(packageJson.name)});\n\nconst client = createClient({ retries: 0 });\nif (!(client instanceof GoogleTrendsClient)) {\n  throw new Error('CommonJS require did not return a GoogleTrendsClient.');\n}\nconsole.log('CommonJS package import passed.');\n`,
  );

  run(process.execPath, ['esm.mjs'], { cwd: temporaryDirectory });
  run(process.execPath, ['cjs.cjs'], { cwd: temporaryDirectory });

  console.log(
    `Packed consumer test passed for ${packageJson.name}@${packageJson.version} (${basename(tarballPath)}).`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });

  if (tarballPath !== undefined) {
    await rm(tarballPath, { force: true });
  }
}
