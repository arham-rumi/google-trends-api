import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const validators = [
  ['Interest Over Time', 'scripts/verify-interest-over-time-live.mjs'],
  ['Interest By Region', 'scripts/verify-interest-by-region-live.mjs'],
  ['Related Queries', 'scripts/verify-related-queries-live.mjs'],
  ['Related Topics', 'scripts/verify-related-topics-live.mjs'],
  ['Trending Now', 'scripts/verify-trending-now-live.mjs'],
  ['Autocomplete', 'scripts/verify-autocomplete-live.mjs'],
];

const DEFAULT_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;

function parseDelay(value) {
  if (value === undefined || value === '') {
    return DEFAULT_DELAY_MS;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_DELAY_MS) {
    throw new Error(
      `GOOGLE_TRENDS_LIVE_VERIFY_DELAY_MS must be an integer between 0 and ${MAX_DELAY_MS}.`,
    );
  }

  return parsed;
}

function runValidator(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${script} terminated by signal ${signal}.`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

function printSummary(results, delayMs) {
  const passed = results.filter((result) => result.status === 'passed').length;
  const rateLimited = results.filter((result) => result.status === 'rate-limited').length;
  const failed = results.filter((result) => result.status === 'failed').length;

  console.log(
    JSON.stringify(
      {
        status: failed > 0 ? 'failed' : rateLimited > 0 ? 'rate-limited' : 'passed',
        delayMs,
        completed: results.length,
        total: validators.length,
        passed,
        rateLimited,
        failed,
        checks: results,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const delayMs = parseDelay(process.env.GOOGLE_TRENDS_LIVE_VERIFY_DELAY_MS);
  const results = [];

  console.log(`Running ${validators.length} deep Google Trends live validators.`);
  console.log(`Delay between successful validators: ${delayMs} ms.`);
  console.log('Each validator uses the already-built dist output.\n');

  for (let index = 0; index < validators.length; index += 1) {
    const [name, script] = validators[index];

    console.log(`\n=== ${index + 1}/${validators.length}: ${name} ===`);

    const startedAt = Date.now();
    const exitCode = await runValidator(script);
    const durationMs = Date.now() - startedAt;

    if (exitCode === 0) {
      results.push({ name, script, status: 'passed', exitCode, durationMs });
    } else if (exitCode === 2) {
      results.push({ name, script, status: 'rate-limited', exitCode, durationMs });
      console.error(
        `\n${name} was rate-limited. Stopping the aggregate run to avoid increasing Google's cooldown.`,
      );
      printSummary(results, delayMs);
      process.exitCode = 2;
      return;
    } else {
      results.push({ name, script, status: 'failed', exitCode, durationMs });
      console.error(`\n${name} failed with exit code ${exitCode}. Stopping the aggregate run.`);
      printSummary(results, delayMs);
      process.exitCode = 1;
      return;
    }

    if (index < validators.length - 1 && delayMs > 0) {
      console.log(`\nWaiting ${delayMs} ms before the next live validator...`);
      await sleep(delayMs);
    }
  }

  console.log('\n=== Deep live verification complete ===');
  printSummary(results, delayMs);
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        status: 'failed',
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
