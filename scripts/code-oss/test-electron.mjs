import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const upstreamRequire = createRequire(new URL('../../.code-oss/src/package.json', import.meta.url));
let cli;
try {
  cli = upstreamRequire.resolve('@playwright/test/cli');
} catch {
  throw new Error('Code OSS Playwright is missing. Run pnpm code-oss:bootstrap and pnpm code-oss:install first.');
}
const args = process.argv.slice(2).filter(argument => argument !== '--');
if (!args.includes('--list') && !args.includes('--help')) {
  for (const file of ['.code-oss/src/out/main.js', '.artifacts/glyph-desktop-host/dist/desktop/host/utilityMain.js']) {
    await access(new URL(`../../${file}`, import.meta.url)).catch(() => {
      throw new Error(
        `Missing ${file}. Run pnpm desktop:artifact, pnpm code-oss:apply, and pnpm code-oss:compile first.`,
      );
    });
  }
}
const node = fileURLToPath(
  new URL(
    `../../.code-oss/node-runtime/node_modules/node/bin/${process.platform === 'win32' ? 'node.exe' : 'node'}`,
    import.meta.url,
  ),
);
const child = spawn(node, [cli, 'test', '--config', 'code-oss/tests/electron/playwright.config.mjs', ...args], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
child.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', code => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
