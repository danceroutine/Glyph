import { accumulateProcessCoverage, readProcessCoverage } from '#scripts/coverage/record-coverage.mjs';
import { backgroundExecutablePath } from './backgroundApplication.mjs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from './playwright.mjs';
import { GlyphWorkbench } from './GlyphWorkbench.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

const sourceRoot = fileURLToPath(new URL('../../../.code-oss/src', import.meta.url));
const coverageDirectory = process.env.GLYPH_COVERAGE_DIR;
export const sentinel = 'Untouched integration fixture.\n';

function coverageFile(parallelIndex) {
  return join(coverageDirectory, `electron-${parallelIndex}.json`);
}

async function prune(directory, files, directories) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && directories.has(path)) await prune(path, files, directories);
    else if (!entry.isFile() || !files.has(path)) await rm(path, { recursive: true, force: true });
  }
}

async function restoreTree(root, contents) {
  const files = new Map(Object.entries(contents).map(([path, text]) => [join(root, path), text]));
  const directories = new Set([root]);
  for (const path of files.keys())
    for (let parent = dirname(path); !directories.has(parent); parent = dirname(parent)) directories.add(parent);
  await mkdir(root, { recursive: true });
  await prune(root, files, directories);
  for (const [path, text] of files) {
    if ((await readFile(path, 'utf8').catch(() => undefined)) === text) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

/** One Code OSS process and sandbox. Consecutive tests with identical launch options may reuse it after a reset. */
export class GlyphSession {
  logs = [];
  logStart = 0;
  navigations = 0;
  host = '';
  tracing = false;
  coverage = false;

  constructor(options) {
    this.options = options;
    this.key = JSON.stringify(options);
  }

  async start() {
    const { options } = this;
    // macOS Unix socket paths are limited to 103 bytes. Descriptive test titles
    // belong in the report, not in Code OSS's user-data directory path.
    this.sandbox = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'glyph-e2e-'));
    this.workspace = join(this.sandbox, 'workspace');
    this.rootPaths = [this.workspace, ...options.additionalRoots.map(root => join(this.sandbox, root.name))];
    this.workspaceTarget = options.additionalRoots.length
      ? join(this.sandbox, 'fixture.code-workspace')
      : this.workspace;
    this.userData = join(this.sandbox, 'user-data');
    await this.restoreFiles();
    if (options.additionalRoots.length)
      await writeFile(this.workspaceTarget, JSON.stringify({ folders: this.rootPaths.map(path => ({ path })) }));
    this.userFiles = {
      'settings.json': JSON.stringify({
        'workbench.startupEditor': 'none',
        'workbench.tips.enabled': false,
        'window.restoreWindows': 'none',
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoUpdate': 'off',
        'extensions.autoCheckUpdates': false,
        'chat.disableAIFeatures': true,
        'security.workspace.trust.startupPrompt': 'never',
        ...options.userSettings,
      }),
      'keybindings.json': JSON.stringify(options.userKeybindings),
    };
    await mkdir(join(this.userData, 'User'), { recursive: true });
    for (const [name, text] of Object.entries(this.userFiles)) await writeFile(join(this.userData, 'User', name), text);
    const product = JSON.parse(await readFile(join(sourceRoot, 'product.json'), 'utf8'));
    const executablePath =
      process.platform === 'darwin'
        ? backgroundExecutablePath()
        : join(
            sourceRoot,
            '.build/electron',
            process.platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName,
          );
    const env = {
      ...process.env,
      NODE_ENV: 'development',
      VSCODE_DEV: '1',
      GLYPH_CONFIG_DIR: join(this.sandbox, 'glyph-config'),
      CHAT_TRACE_FILE: join(this.sandbox, 'glyph-trace.log'),
      GLYPH_DESKTOP_TEST_STREAM_DELAY_MS: '80',
    };
    for (const key of [
      'ELECTRON_RUN_AS_NODE',
      'VSCODE_CLI',
      'VSCODE_ESM_ENTRYPOINT',
      'VSCODE_IPC_HOOK',
      'CHAT_MODEL',
      'GLYPH_DESKTOP_TEST_RUNTIME',
      'GLYPH_DESKTOP_TEST_PROVIDER_URL',
      ...Object.keys(env).filter(key => key.startsWith('OPENAI_')),
    ]) {
      delete env[key];
    }
    if (options.scriptedProvider) {
      this.provider = new ScriptedProvider(options.scriptedAccounts);
      await this.provider.start();
      env.GLYPH_DESKTOP_TEST_RUNTIME = 'scripted';
      env.GLYPH_DESKTOP_TEST_PROVIDER_URL = this.provider.url;
      await mkdir(env.GLYPH_CONFIG_DIR, { recursive: true, mode: 0o700 });
      await writeFile(
        join(env.GLYPH_CONFIG_DIR, 'accounts.json'),
        JSON.stringify({
          version: 1,
          hostId: 'urn:uuid:electron-fixture',
          accounts: this.provider.accounts.map(account => ({
            clientId: 'electron-fixture',
            subject: account.subject,
            email: account.email,
            planNoticeSeen: true,
            tokens: {
              accessToken: account.token,
              refreshToken: 'unused-fixture-refresh',
              idToken: 'unused-fixture-id',
              expiresAt: Date.now() + 3_600_000,
              scopes: ['chatgpt.tokens.use.direct'],
            },
          })),
        }),
        { mode: 0o600 },
      );
    } else if (!options.productionRuntime) env.GLYPH_DESKTOP_TEST_RUNTIME = 'deterministic';
    if (coverageDirectory) env.NODE_V8_COVERAGE = join(this.sandbox, 'coverage');
    this.application = await _electron.launch({
      executablePath,
      cwd: sourceRoot,
      env,
      timeout: 60_000,
      args: [
        sourceRoot,
        this.workspaceTarget,
        '--new-window',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-telemetry',
        '--disable-experiments',
        '--disable-updates',
        ...(options.extensionDevelopmentPath
          ? [`--extensionDevelopmentPath=${options.extensionDevelopmentPath}`]
          : ['--disable-extensions']),
        ...(options.trustedWorkspace ? ['--disable-workspace-trust'] : []),
        '--use-inmemory-secretstorage',
        '--force-disable-user-env',
        '--no-cached-data',
        `--user-data-dir=${this.userData}`,
        `--extensions-dir=${join(this.sandbox, 'extensions')}`,
        `--logsPath=${join(this.sandbox, 'logs')}`,
        `--crash-reporter-directory=${join(this.sandbox, 'crashes')}`,
      ],
    });
    if (process.platform === 'darwin')
      await this.application.evaluate(({ app, BrowserWindow }) => {
        const conceal = window => {
          window.setOpacity(0);
          window.setIgnoreMouseEvents(true);
        };
        for (const window of BrowserWindow.getAllWindows()) conceal(window);
        app.on('browser-window-created', (_event, window) => conceal(window));
      });
    this.application.process().stdout?.on('data', value => this.logs.push(String(value)));
    this.application.process().stderr?.on('data', value => this.logs.push(String(value)));
    await this.application.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    this.tracing = true;
    this.page = await this.application.firstWindow();
    if (coverageDirectory) {
      await this.page.coverage.startJSCoverage({ resetOnNavigation: false });
      this.coverage = true;
    }
    this.page.on('console', message => this.logs.push(`[renderer ${message.type()}] ${message.text()}\n`));
    this.page.on('pageerror', error => this.logs.push(`[renderer error] ${error.stack}\n`));
    const glyph = this.workbench();
    await glyph.open();
    this.noticeHandler = glyph.extensionNoticeHandler;
    this.page.on('domcontentloaded', () => this.navigations++);
    this.sandboxEntries = new Set(await readdir(this.sandbox));
    this.baseline = await this.snapshot(glyph);
    this.userFiles = await this.readUserFiles();
  }

  async readUserFiles() {
    const files = {};
    for (const name of Object.keys(this.userFiles))
      files[name] = await readFile(join(this.userData, 'User', name), 'utf8').catch(() => undefined);
    return files;
  }

  workbench() {
    const glyph = new GlyphWorkbench(this.page, this.application);
    glyph.workspace = this.workspace;
    glyph.workspaceTarget = this.workspaceTarget;
    glyph.rootPaths = this.rootPaths;
    glyph.extensionNoticeHandler = this.noticeHandler;
    return glyph;
  }

  async restoreFiles() {
    await restoreTree(this.workspace, { 'example.txt': sentinel, ...this.options.workspaceFiles });
    for (const [index, root] of this.options.additionalRoots.entries())
      await restoreTree(this.rootPaths[index + 1], root.files);
  }

  async userFilesChanged() {
    const files = await this.readUserFiles();
    return Object.keys(files).some(name => files[name] !== this.userFiles[name]);
  }

  hostProcesses() {
    return this.application.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .filter(metric => metric.type === 'Utility' && metric.name?.startsWith('glyphHost-'))
        .map(metric => metric.pid)
        .join(),
    );
  }

  async snapshot(glyph) {
    const { page } = this;
    const layout = await page.evaluate(() => {
      const box = selector => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect?.width && rect.height ? [rect.x, rect.y, rect.width, rect.height].map(Math.round) : 'hidden';
      };
      return {
        window: `${innerWidth}x${innerHeight}`,
        theme: [...document.querySelector('.monaco-workbench').classList]
          .filter(name => /^(vs|vs-dark|hc-black|hc-light)$/.test(name))
          .join(),
        sidebar: box('.part.sidebar'),
        auxiliarybar: box('.part.auxiliarybar'),
        panel: box('.part.panel'),
        editor: box('.part.editor'),
      };
    });
    return {
      ...layout,
      windows: this.application.windows().length,
      editors: await page.locator('.part.editor .tab').count(),
      modalEditors: await page.getByRole('button', { name: /^Close Modal Editor/ }).count(),
      chats: await page.getByRole('tablist', { name: 'Open chats' }).getByRole('tab').count(),
      entries: await page.locator('.glyph-transcript .glyph-entry').count(),
      composer: await glyph.composer.innerText({ timeout: 2_000 }),
      composerAlerts: await page.locator('.glyph-composer').getByRole('alert').count(),
      send: await glyph.sendButton.innerText({ timeout: 2_000 }),
      mode: await page.getByRole('combobox', { name: 'Conversation mode' }).innerText({ timeout: 2_000 }),
      model: await page.getByRole('combobox', { name: 'Model' }).innerText({ timeout: 2_000 }),
      surfaces: await page
        .getByRole('region', {
          name: /^(Queued messages|Pending reviews|Background terminals|Unsent messages|Command approval|Attachment preview)$/,
        })
        .count(),
      history: await page.getByRole('complementary', { name: 'Chat history' }).count(),
      quickInput: await page.locator('.quick-input-widget').isVisible(),
    };
  }

  differences(current) {
    return Object.keys(this.baseline).filter(key => {
      const [expected, actual] = [this.baseline[key], current[key]];
      if (Array.isArray(expected) && Array.isArray(actual))
        return expected.some((value, index) => Math.abs(value - actual[index]) > 2);
      return expected !== actual;
    });
  }

  async disruption() {
    if (this.page.isClosed()) return 'window closed';
    if (this.application.windows().length !== 1) return 'another window opened';
    if (this.navigations) return 'window reloaded';
    if (this.host && (await this.hostProcesses()) !== this.host) return 'host restarted';
    if (this.provider && !this.provider.settled) return 'provider work outstanding';
    if (await this.page.getByRole('region', { name: 'Queued messages', exact: true }).count())
      return 'queued messages remain';
    if (await this.userFilesChanged()) return 'user settings changed';
    return undefined;
  }

  async reset() {
    if (!this.provider) return 'only the scripted runtime can open a new chat';
    await this.application.context().tracing.startChunk();
    this.tracing = true;
    this.logStart = this.logs.length;
    const { page } = this;
    const glyph = this.workbench();
    if ((await glyph.sendButton.innerText({ timeout: 5_000 })) !== this.baseline.send)
      return 'a response is still running';
    await page.keyboard.press('Escape');
    const closeModal = page.getByRole('button', { name: /^Close Modal Editor/ });
    for (let attempt = 0; attempt < 5 && (await closeModal.count()); attempt++) await closeModal.first().click();
    for (let attempt = 0; attempt < 20; attempt++) {
      const dirty = page.locator('.part.editor .tab.dirty');
      if (!(await dirty.count())) break;
      await dirty.first().click();
      await glyph.command('View: Revert and Close Editor');
    }
    if (await page.locator('.part.editor .tab').count()) await glyph.command('View: Close All Editor Groups');
    await glyph.command('Notifications: Clear All Notifications');
    await glyph.command('View: Focus Active Editor Group');
    await glyph.open();
    const pending = page.getByRole('region', { name: 'Pending reviews', exact: true });
    if (await pending.count()) {
      await pending.getByRole('button', { name: /^Keep( All)?$/ }).click({ timeout: 5_000 });
      await expect(pending).toHaveCount(0, { timeout: 5_000 });
    }
    await this.stopBackgroundShells(glyph);
    if (await page.locator('.part.panel').isVisible()) {
      await glyph.command('Terminal: Kill All Terminals');
      if (await page.locator('.part.panel').isVisible()) await glyph.command('View: Hide Panel');
    }
    if ((await page.locator('.part.sidebar').isVisible()) !== (this.baseline.sidebar !== 'hidden'))
      await glyph.command('View: Toggle Primary Side Bar Visibility');
    await expect(async () => {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Chat actions', exact: true }).click({ timeout: 2_000 });
      await page.getByRole('menuitem', { name: 'Close All Chat Tabs', exact: true }).click({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await this.restoreFiles();
    for (const entry of await readdir(this.sandbox))
      if (!this.sandboxEntries.has(entry)) await rm(join(this.sandbox, entry), { recursive: true, force: true });
    this.provider?.reset();
    await glyph.command('View: Focus Active Editor Group');
    await glyph.open();
    try {
      await expect.poll(async () => this.differences(await this.snapshot(glyph)), { timeout: 10_000 }).toEqual([]);
    } catch {
      const current = await this.snapshot(glyph);
      return `workbench differs in ${this.differences(current)
        .map(key => `${key} (${this.baseline[key]} -> ${current[key]})`)
        .join(', ')}`;
    }
    return undefined;
  }

  async stopBackgroundShells(glyph) {
    const { page } = this;
    const tabs = page.getByRole('tablist', { name: 'Open chats' }).getByRole('tab');
    const drawer = page.getByRole('region', { name: 'Background terminals', exact: true });
    const marker = 'Background terminal stopped before the next test.';
    const replies = glyph.assistantEntries.filter({ hasText: marker });
    this.provider.fallback = { chunks: [marker] };
    for (let index = 0; index < (await tabs.count()); index++) {
      await tabs.nth(index).click();
      await expect(tabs.nth(index)).toHaveAttribute('aria-selected', 'true');
      await expect(glyph.composer).toBeVisible();
      for (let attempt = 0; attempt < 10 && (await drawer.count()); attempt++) {
        const stopped = await replies.count();
        const toggle = drawer.getByRole('button', { name: /background terminals?$/ });
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        await drawer.getByRole('button', { name: 'Stop', exact: true }).first().click();
        await expect(replies).toHaveCount(stopped + 1, { timeout: 10_000 });
        await expect(glyph.sendButton).toHaveText(this.baseline.send, { timeout: 10_000 });
      }
      if (await drawer.count()) throw new Error('Background terminals are still running.');
    }
  }

  async begin() {
    if (coverageDirectory && !this.coverage) {
      await this.page.coverage.startJSCoverage({ resetOnNavigation: false });
      this.coverage = true;
    }
    this.navigations = 0;
    this.host = await this.hostProcesses();
    this.glyph = this.workbench();
  }

  async finish(testInfo, keep) {
    if (this.glyph) this.noticeHandler = this.glyph.extensionNoticeHandler;
    const page = this.page && !this.page.isClosed() ? this.page : undefined;
    if (this.coverage) {
      this.coverage = false;
      const result = page ? await page.coverage.stopJSCoverage().catch(() => []) : [];
      await accumulateProcessCoverage(coverageFile(testInfo.parallelIndex), [{ result }]);
    }
    if (page) {
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
    if (this.application && this.tracing) {
      this.tracing = false;
      await this.application
        .context()
        .tracing.stopChunk({ path: testInfo.outputPath('trace.zip') })
        .then(() =>
          testInfo.attach('trace', {
            path: testInfo.outputPath('trace.zip'),
            contentType: 'application/zip',
          }),
        )
        .catch(() => {});
    }
    if (!keep) await this.shutdown(testInfo.parallelIndex);
    await writeFile(testInfo.outputPath('electron.log'), this.logs.slice(this.logStart).join(''));
    if (this.provider) {
      await writeFile(
        testInfo.outputPath('provider-requests.json'),
        JSON.stringify(
          this.provider.requests.map(request => ({
            body: request.body,
            completed: request.completed,
            closed: request.closed,
          })),
          null,
          2,
        ),
      );
      await testInfo.attach('Scripted provider requests', {
        path: testInfo.outputPath('provider-requests.json'),
        contentType: 'application/json',
      });
    }
    await testInfo.attach('Electron log', { path: testInfo.outputPath('electron.log'), contentType: 'text/plain' });
    if (this.sandbox) {
      await cp(join(this.sandbox, 'logs'), testInfo.outputPath('logs'), { recursive: true }).catch(() => {});
      await cp(join(this.sandbox, 'crashes'), testInfo.outputPath('crashes'), { recursive: true }).catch(() => {});
      if (!keep) await rm(this.sandbox, { recursive: true, force: true });
    }
  }

  async shutdown(parallelIndex) {
    if (this.application) {
      if (this.coverage && !this.page.isClosed()) {
        this.coverage = false;
        const result = await this.page.coverage.stopJSCoverage().catch(() => []);
        await accumulateProcessCoverage(coverageFile(parallelIndex), [{ result }]);
      }
      await this.application
        .context()
        .tracing.stop()
        .catch(() => {});
      await this.application.close().catch(() => this.application.process().kill());
    }
    await this.provider?.close();
    if (coverageDirectory && this.sandbox)
      await accumulateProcessCoverage(
        coverageFile(parallelIndex),
        await readProcessCoverage(join(this.sandbox, 'coverage')),
      );
  }

  async abandon(testInfo) {
    if (this.tracing) {
      this.tracing = false;
      await this.application
        .context()
        .tracing.stopChunk({ path: testInfo.outputPath('reset-trace.zip') })
        .then(() =>
          testInfo.attach('Reset trace', {
            path: testInfo.outputPath('reset-trace.zip'),
            contentType: 'application/zip',
          }),
        )
        .catch(() => {});
    }
    await this.close(testInfo.parallelIndex);
  }

  async close(parallelIndex) {
    await this.shutdown(parallelIndex);
    if (this.sandbox) await rm(this.sandbox, { recursive: true, force: true });
  }
}
