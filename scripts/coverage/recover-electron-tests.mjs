import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  finishElectronRecovery,
  planElectronRecovery,
  readElectronReport,
  recoveryManifest,
  recoveryPlan,
} from './electron-recovery.mjs';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, '.artifacts/electron-recovery');
const reportPath = resolve(directory, 'results.json');
/** @param {string} executable @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
const run = (executable, args, env = process.env) =>
  execFileSync(executable, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
/** @param {string} path @returns {Promise<unknown>} */
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
/** @param {string} name @param {unknown} value */
const save = async (name, value) => writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`);

const environment = z.object({
  GITHUB_REPOSITORY: z.string().min(1),
  GITHUB_RUN_ID: z.string().regex(/^\d+$/u),
  GITHUB_RUN_ATTEMPT: z.string().regex(/^\d+$/u),
  PR_NUMBER: z.string().regex(/^\d+$/u),
  PR_HEAD_SHA: z.string().regex(/^[a-f0-9]{40}$/u),
  PR_BASE_SHA: z.string().regex(/^[a-f0-9]{40}$/u),
  PR_HEAD_REPOSITORY: z.string(),
  PR_HEAD_BRANCH: z.string(),
  RUNNER_OS: z.string(),
  RUNNER_ARCH: z.string(),
  ImageOS: z.string(),
  ImageVersion: z.string(),
});
const workflowRuns = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int().positive(),
      run_attempt: z.number().int().positive(),
      head_sha: z.string(),
      head_repository: z.object({ full_name: z.string() }),
      pull_requests: z.array(z.object({ number: z.number() })),
    }),
  ),
});

/** Only download evidence from this repository's same PR and workflow, never fork artifacts.
 * @param {z.infer<typeof environment>} env
 */
async function restore(env) {
  if (env.PR_HEAD_REPOSITORY !== env.GITHUB_REPOSITORY) return null;
  try {
    const endpoint = `repos/${env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&branch=${encodeURIComponent(env.PR_HEAD_BRANCH)}&per_page=20`;
    const runs = workflowRuns.parse(JSON.parse(run('gh', ['api', endpoint]))).workflow_runs;
    if (Number(env.GITHUB_RUN_ATTEMPT) > 1) {
      // A rerun keeps its run ID and is absent from the completed-runs query.
      runs.unshift({
        id: Number(env.GITHUB_RUN_ID),
        run_attempt: Number(env.GITHUB_RUN_ATTEMPT) - 1,
        head_sha: env.PR_HEAD_SHA,
        head_repository: { full_name: env.GITHUB_REPOSITORY },
        pull_requests: [{ number: Number(env.PR_NUMBER) }],
      });
    }
    for (const candidate of runs) {
      if (
        candidate.head_repository.full_name !== env.GITHUB_REPOSITORY ||
        !candidate.pull_requests.some(pr => String(pr.number) === env.PR_NUMBER)
      )
        continue;
      const destination = resolve(directory, 'restored', `${candidate.id}-${candidate.run_attempt}`);
      try {
        run('gh', [
          'run',
          'download',
          String(candidate.id),
          '--repo',
          env.GITHUB_REPOSITORY,
          '--name',
          `electron-recovery-${candidate.id}-${candidate.run_attempt}`,
          '--dir',
          destination,
        ]);
        const manifest = recoveryManifest.parse(await readJson(resolve(destination, 'manifest.json')));
        if (
          manifest.run === String(candidate.id) &&
          manifest.attempt === String(candidate.run_attempt) &&
          manifest.context.head === candidate.head_sha &&
          manifest.context.repository === env.GITHUB_REPOSITORY &&
          manifest.context.pullRequest === env.PR_NUMBER
        )
          return manifest;
      } catch {
        // Missing/expired/corrupt artifacts are a cache miss, never permission to skip tests.
      }
    }
  } catch {
    // Read-only artifact access may be unavailable, especially in restricted PRs.
  }
  return null;
}

async function prepare() {
  const env = environment.parse(process.env);
  const inventoryPath = resolve(directory, 'inventory.json');
  run(process.execPath, ['scripts/code-oss/test-electron.mjs', '--list', '--reporter=json'], {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_FILE: inventoryPath,
  });
  const inventory = readElectronReport(await readJson(inventoryPath));
  if (inventory.tests.length === 0) throw new Error('Electron inventory is empty.');
  const previous = await restore(env);
  let ancestor = false;
  /** @type {string[]} */
  let changed = [];
  if (previous !== null) {
    try {
      run('git', ['merge-base', '--is-ancestor', previous.context.head, env.PR_HEAD_SHA]);
      changed = run('git', ['diff', '--name-only', '--no-renames', '-z', previous.context.head, env.PR_HEAD_SHA, '--'])
        .split('\0')
        .filter(Boolean);
      ancestor = true;
    } catch {
      // Force-pushes and unavailable history invalidate reuse.
    }
  }
  const available = run('git', ['ls-files', '-z', 'code-oss/tests/electron/*.test.mjs']).split('\0').filter(Boolean);
  const { rules } = z
    .object({
      rules: z.array(z.object({ area: z.string(), prefixes: z.array(z.string()), tests: z.array(z.string()) })),
    })
    .parse(await readJson(resolve(root, 'scripts/coverage/electron-test-policy.json')));
  const plan = planElectronRecovery({
    context: {
      repository: env.GITHUB_REPOSITORY,
      pullRequest: env.PR_NUMBER,
      head: env.PR_HEAD_SHA,
      base: env.PR_BASE_SHA,
      platform: `${env.RUNNER_OS}-${env.RUNNER_ARCH}-${env.ImageOS}-${env.ImageVersion}-node${process.version}`,
      playwright: inventory.playwright,
    },
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    tests: inventory.tests,
    previous,
    ancestor,
    changed,
    available,
    rules,
  });
  await save('plan.json', plan);
  // The pinned Playwright --last-failed-file selects exact IDs, without title regex/prefix ambiguity.
  await save('last-run.json', { status: 'failed', failedTests: plan.remaining });
  await rm(reportPath, { force: true });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `execute=${String(plan.execute)}\n`);
  await summarize(plan, 'planned');
}

async function finish() {
  const plan = recoveryPlan.parse(await readJson(resolve(directory, 'plan.json')));
  let report = null;
  try {
    report = readElectronReport(await readJson(reportPath));
  } catch {
    // Preserve inherited evidence even if this runner was interrupted before reporting.
  }
  const { manifest, complete } = finishElectronRecovery(plan, report);
  await save('manifest.json', manifest);
  await summarize(plan, complete ? 'recorded' : 'incomplete');
  if (!complete) throw new Error('Electron execution did not report every planned test; incomplete evidence retained.');
}

/** @param {z.infer<typeof recoveryPlan>} plan @param {string} phase */
async function summarize(plan, phase) {
  const text = `Electron recovery ${phase}: ${plan.reused.length} clean passes reused, ${plan.remaining.length} test IDs remaining (including pending contracts). ${plan.reason}\n`;
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${text}\n`);
}

await mkdir(directory, { recursive: true });
switch (process.argv[2]) {
  case 'prepare':
    await prepare();
    break;
  case 'finish':
    await finish();
    break;
  default:
    throw new Error('Use prepare or finish for Electron recovery.');
}
