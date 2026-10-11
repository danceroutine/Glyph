import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test as base } from './playwright.mjs';
import { GlyphWorkbench } from './GlyphWorkbench.mjs';

const sourceRoot = fileURLToPath(new URL('../../../.code-oss/src', import.meta.url));

/** Each test owns a fresh profile, workspace, extensions directory, and Electron process. */
export const test = base.extend({
  trustedWorkspace: [true, { option: true }],
  productionRuntime: [false, { option: true }],
  glyph: async ({ trustedWorkspace, productionRuntime }, use, testInfo) => {
    // macOS Unix socket paths are limited to 103 bytes. Descriptive test titles
    // belong in the report, not in Code OSS's user-data directory path.
    const sandbox = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'glyph-e2e-'));
    const workspace = join(sandbox, 'workspace');
    const userData = join(sandbox, 'user-data');
    const logs = [];
    await mkdir(workspace, { recursive: true });
    await mkdir(join(userData, 'User'), { recursive: true });
    await writeFile(join(workspace, 'example.txt'), 'Untouched integration fixture.\n');
    await writeFile(
      join(userData, 'User', 'settings.json'),
      JSON.stringify({
        'workbench.startupEditor': 'none',
        'workbench.tips.enabled': false,
        'window.restoreWindows': 'none',
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
        'chat.disableAIFeatures': true,
        'security.workspace.trust.startupPrompt': 'never',
      }),
    );
    const product = JSON.parse(await readFile(join(sourceRoot, 'product.json'), 'utf8'));
    const executablePath =
      process.platform === 'darwin'
        ? join(sourceRoot, '.build/electron', `${product.nameLong}.app`, 'Contents/MacOS', product.nameShort)
        : join(
            sourceRoot,
            '.build/electron',
            process.platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName,
          );
    const env = {
      ...process.env,
      NODE_ENV: 'development',
      VSCODE_DEV: '1',
      GLYPH_CONFIG_DIR: join(sandbox, 'glyph-config'),
      CHAT_TRACE_FILE: join(sandbox, 'glyph-trace.log'),
      GLYPH_DESKTOP_TEST_STREAM_DELAY_MS: '80',
    };
    for (const key of [
      'ELECTRON_RUN_AS_NODE',
      'VSCODE_CLI',
      'VSCODE_ESM_ENTRYPOINT',
      'VSCODE_IPC_HOOK',
      'CHAT_MODEL',
      'GLYPH_DESKTOP_TEST_RUNTIME',
      ...Object.keys(env).filter(key => key.startsWith('OPENAI_')),
    ]) {
      delete env[key];
    }
    if (!productionRuntime) env.GLYPH_DESKTOP_TEST_RUNTIME = 'deterministic';
    let application;
    let page;
    try {
      application = await _electron.launch({
        executablePath,
        cwd: sourceRoot,
        env,
        timeout: 60_000,
        args: [
          sourceRoot,
          workspace,
          '--new-window',
          '--skip-welcome',
          '--skip-release-notes',
          '--disable-telemetry',
          '--disable-experiments',
          '--disable-updates',
          '--disable-extensions',
          ...(trustedWorkspace ? ['--disable-workspace-trust'] : []),
          '--use-inmemory-secretstorage',
          '--no-cached-data',
          `--user-data-dir=${userData}`,
          `--extensions-dir=${join(sandbox, 'extensions')}`,
          `--logsPath=${join(sandbox, 'logs')}`,
          `--crash-reporter-directory=${join(sandbox, 'crashes')}`,
        ],
      });
      application.process().stdout?.on('data', value => logs.push(String(value)));
      application.process().stderr?.on('data', value => logs.push(String(value)));
      await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      page = await application.firstWindow();
      page.on('console', message => logs.push(`[renderer ${message.type()}] ${message.text()}\n`));
      page.on('pageerror', error => logs.push(`[renderer error] ${error.stack}\n`));
      const glyph = new GlyphWorkbench(page, application);
      await glyph.open();
      await use(glyph);
      expect(await readFile(join(workspace, 'example.txt'), 'utf8')).toBe('Untouched integration fixture.\n');
    } finally {
      if (page && !page.isClosed()) {
        await page
          .screenshot({ path: testInfo.outputPath('workbench.png') })
          .then(() =>
            testInfo.attach('Workbench screenshot', {
              path: testInfo.outputPath('workbench.png'),
              contentType: 'image/png',
            }),
          )
          .catch(() => {});
      }
      if (application) {
        await application
          .context()
          .tracing.stop({ path: testInfo.outputPath('trace.zip') })
          .then(() =>
            testInfo.attach('trace', {
              path: testInfo.outputPath('trace.zip'),
              contentType: 'application/zip',
            }),
          )
          .catch(() => {});
        await application.close().catch(() => application.process().kill());
      }
      await writeFile(testInfo.outputPath('electron.log'), logs.join(''));
      await testInfo.attach('Electron log', { path: testInfo.outputPath('electron.log'), contentType: 'text/plain' });
      await cp(join(sandbox, 'logs'), testInfo.outputPath('logs'), { recursive: true }).catch(() => {});
      await cp(join(sandbox, 'crashes'), testInfo.outputPath('crashes'), { recursive: true }).catch(() => {});
      await rm(sandbox, { recursive: true, force: true });
    }
  },
});

export { expect };
