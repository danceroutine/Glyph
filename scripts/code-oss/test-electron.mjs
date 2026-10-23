import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = fileURLToPath(new URL('../..', import.meta.url));
const upstreamRequire = createRequire(new URL('../../.code-oss/src/package.json', import.meta.url));
let cli;
try {
  cli = upstreamRequire.resolve('@playwright/test/cli');
} catch {
  throw new Error('Code OSS Playwright is missing. Run pnpm code-oss:bootstrap and pnpm code-oss:install first.');
}
const args = process.argv.slice(2).filter(argument => argument !== '--');
if (process.env.GLYPH_ELECTRON_RECOVERY) {
  z.object({ status: z.literal('failed'), failedTests: z.array(z.string().min(1)).min(1) }).parse(
    JSON.parse(await readFile(process.env.GLYPH_ELECTRON_RECOVERY, 'utf8')),
  );
  args.push('--last-failed', '--last-failed-file', process.env.GLYPH_ELECTRON_RECOVERY);
}
if (process.env.GLYPH_ELECTRON_SELECTION) {
  const selection = z
    .object({ mode: z.enum(['full', 'selected']), tests: z.array(z.string()).min(1) })
    .parse(JSON.parse(await readFile(process.env.GLYPH_ELECTRON_SELECTION, 'utf8')));
  for (const file of selection.tests) {
    if (!/^code-oss\/tests\/electron\/[^/]+\.test\.mjs$/u.test(file))
      throw new Error('Invalid Electron suite path in selection.');
    args.push(`${file.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`);
  }
}
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
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM']))
  process.on(signal, () => {
    child.kill(signal);
  });
