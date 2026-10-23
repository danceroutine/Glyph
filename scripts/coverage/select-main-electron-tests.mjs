import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '../..');
const env = z
  .object({
    GITHUB_EVENT_NAME: z.literal('push'),
    GITHUB_REF: z.literal('refs/heads/main'),
    GITHUB_REPOSITORY: z.string().min(1),
    GITHUB_SHA: z.string().regex(/^[a-f0-9]{40}$/u),
  })
  .parse(process.env);
/** @param {string} executable @param {string[]} args */
const run = (executable, args) =>
  execFileSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const runsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
      head_branch: z.string(),
      head_repository: z.object({ full_name: z.string() }),
    }),
  ),
});
let base;
try {
  const endpoint = `repos/${env.GITHUB_REPOSITORY}/actions/workflows/integration.yml/runs?event=push&status=success&branch=main&per_page=100`;
  const runs = runsSchema.parse(JSON.parse(run('gh', ['api', endpoint]))).workflow_runs;
  for (const candidate of runs) {
    if (candidate.head_branch !== 'main' || candidate.head_repository.full_name !== env.GITHUB_REPOSITORY) continue;
    try {
      run('git', ['merge-base', '--is-ancestor', candidate.head_sha, env.GITHUB_SHA]);
      base = candidate.head_sha;
      break;
    } catch {
      // A newer or force-pushed history is not proof about this checkout.
    }
  }
} catch {
  // No known baseline means full selection, never silently skipping work.
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `base=${base ?? '0'.repeat(40)}\n`);
process.stdout.write(
  run(process.execPath, [
    'scripts/coverage/select-electron-tests.mjs',
    ...(base ? ['--base', base] : []),
    '--output',
    '.artifacts/electron-selection.json',
  ]),
);
