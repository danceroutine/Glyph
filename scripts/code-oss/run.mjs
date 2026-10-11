/**
 * @fileoverview Runs upstream Code OSS commands with its pinned Node runtime and
 * npm lockfile while keeping Glyph's root pnpm workspace uncontaminated.
 */
import { readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceRoot = join(repositoryRoot, '.code-oss', 'src');
const runtimeRoot = join(repositoryRoot, '.code-oss', 'node-runtime');
const pin = JSON.parse(await readFile(join(repositoryRoot, 'code-oss', 'upstream.json'), 'utf8'));
const nodeBinary = join(runtimeRoot, 'node_modules', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
const command = process.argv[2];
const forwardedArguments = process.argv[3] === '--' ? process.argv.slice(4) : process.argv.slice(3);

if (!(await exists(join(sourceRoot, '.glyph-upstream.json')))) {
  throw new Error('Run pnpm code-oss:bootstrap first.');
}
if (!(await exists(nodeBinary))) {
  run('npm', ['install', '--prefix', runtimeRoot, `node@${pin.node}`], repositoryRoot, process.env);
}

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
    run('npm', ['install'], sourceRoot, environment);
    break;
  case 'run':
    run('npm', ['run', ...forwardedArguments], sourceRoot, environment);
    break;
  case 'launch':
    run('./scripts/code.sh', forwardedArguments, sourceRoot, environment);
    break;
  default:
    throw new Error(`Unknown Code OSS command: ${String(command)}`);
}

function run(executable, arguments_, cwd, env) {
  const result = spawnSync(executable, arguments_, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function exists(path) {
  return stat(path).then(
    () => true,
    error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}
