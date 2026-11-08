import { spawnSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const projectRoot = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));

const expectedTag = `v${packageJson.version}`;
const currentTag = process.env.GITHUB_REF_NAME;

if (currentTag !== undefined && currentTag !== expectedTag) {
  throw new Error(
    `Git tag ${currentTag} does not match package version ${packageJson.version}. Expected ${expectedTag}.`,
  );
}

const packageSpecifier = `${packageJson.name}@${packageJson.version}`;
if (!/^[A-Za-z0-9@/._+-]+$/.test(packageSpecifier)) {
  throw new Error(`Unsafe npm package specifier: ${packageSpecifier}`);
}

const npmArguments = ['view', packageSpecifier, 'version', '--json'];
const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const commandArguments =
  process.platform === 'win32' ? ['/d', '/s', '/c', `npm ${npmArguments.join(' ')}`] : npmArguments;
const lookup = spawnSync(command, commandArguments, {
  cwd: projectRoot,
  encoding: 'utf8',
  stdio: 'pipe',
});

let alreadyPublished = false;

if (lookup.error !== undefined) {
  throw new Error(`Unable to run npm for ${packageSpecifier}.`, { cause: lookup.error });
}

if (lookup.status === 0) {
  const publishedVersion = JSON.parse(lookup.stdout.trim());
  alreadyPublished = publishedVersion === packageJson.version;
} else {
  const errorOutput = `${lookup.stdout ?? ''}\n${lookup.stderr ?? ''}`;

  if (!/E404|404 Not Found|is not in this registry/i.test(errorOutput)) {
    throw new Error(`Unable to check npm for ${packageSpecifier}.\n${errorOutput.trim()}`);
  }
}

console.log(
  alreadyPublished
    ? `${packageSpecifier} is already published; publishing will be skipped.`
    : `${packageSpecifier} is not published and is ready for release.`,
);

if (process.env.GITHUB_OUTPUT !== undefined) {
  await appendFile(process.env.GITHUB_OUTPUT, `already-published=${String(alreadyPublished)}\n`);
}
