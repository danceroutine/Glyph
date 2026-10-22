/**
 * @fileoverview Runs upstream Code OSS commands with its pinned Node runtime and
 * npm lockfile while keeping Glyph's root pnpm workspace uncontaminated.
 */
import { readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasErrorCode } from '#scripts/support/hasErrorCode.mjs';
import { removeLeakedCodeOssHuskyHooks } from './git-hooks.mjs';
import { z } from 'zod';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceRoot = join(repositoryRoot, '.code-oss', 'src');
const runtimeRoot = join(repositoryRoot, '.code-oss', 'node-runtime');
const pin = z
  .object({ node: z.string() })
  .parse(JSON.parse(await readFile(join(repositoryRoot, 'code-oss', 'upstream.json'), 'utf8')));
const nodeBinary = join(runtimeRoot, 'node_modules', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
const command = process.argv[2];
const forwardedArguments = process.argv[3] === '--' ? process.argv.slice(4) : process.argv.slice(3);

await main().catch((/** @type {unknown} */ error) => {
  process.exitCode =
    typeof error === 'object' && error !== null && 'exitCode' in error && typeof error.exitCode === 'number'
      ? error.exitCode
      : 1;
  console.error(error instanceof Error ? error.message : String(error));
});

async function main() {
  await cleanLeakedHooks();

  if (!(await exists(join(sourceRoot, '.glyph-upstream.json')))) {
    throw new Error('Run pnpm code-oss:bootstrap first.');
  }
  if (!(await exists(nodeBinary))) {
    run('npm', ['install', '--prefix', runtimeRoot, `node@${pin.node}`], repositoryRoot, process.env);
  }

  /** @type {NodeJS.ProcessEnv} */
  const environment = {
    ...process.env,
    PATH: `${dirname(nodeBinary)}${delimiter}${process.env.PATH ?? ''}`,
  };
  // These variables change how upstream's launcher interprets Node/Electron. A
  // developer shell may set them, but forwarding them would make runs non-local.
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.VSCODE_CLI;
  delete environment.VSCODE_ESM_ENTRYPOINT;
  delete environment.VSCODE_IPC_HOOK;

  switch (command) {
    case 'install':
      try {
        run('npm', ['install'], sourceRoot, environment);
      } finally {
        // Upstream still depends on Husky 0.13, which walks to the nearest .git
        // directory and can replace Glyph's hooks from this generated checkout.
        await cleanLeakedHooks();
      }
      break;
    case 'run':
      run('npm', ['run', ...forwardedArguments], sourceRoot, environment);
      break;
    case 'launch':
      run('./scripts/code.sh', forwardedArguments, sourceRoot, environment);
      break;
    default:
      throw new Error(`Unknown Code OSS command: ${command}`);
  }
}

async function cleanLeakedHooks() {
  const removed = await removeLeakedCodeOssHuskyHooks(repositoryRoot);
  if (removed.length > 0) process.stdout.write(`Removed leaked Code OSS Git hooks: ${removed.join(', ')}\n`);
}

/**
 * @param {string} executable
 * @param {string[]} arguments_
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 */
function run(executable, arguments_, cwd, env) {
  const result = spawnSync(executable, arguments_, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  // Throw through the install finally block before choosing the process status.
  if (result.status !== 0)
    throw Object.assign(new Error(`${executable} failed with status ${result.status}.`), {
      exitCode: result.status ?? 1,
    });
}

/** @param {string} path */
async function exists(path) {
  return stat(path).then(
    () => true,
    (/** @type {unknown} */ error) => {
      if (hasErrorCode(error, 'ENOENT')) return false;
      throw error;
    },
  );
}
