import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as base } from './playwright.mjs';
import { GlyphSession, sentinel } from './GlyphSession.mjs';

const sharingEnabled = process.env.GLYPH_ELECTRON_SHARED_LAUNCH !== '0';
const since = start => String(Math.round(performance.now() - start));
const summary = error =>
  error.message
    .replace(/\u001b\[\d+m/g, '')
    .split('\n')
    .filter(line => /\S/.test(line) && !line.includes('Call log'))
    .slice(0, 3)
    .join(' ')
    .slice(0, 300);

export const isolatedLaunch = reason => ({ annotation: { type: 'isolated launch', description: reason } });

/** Each test owns a fresh profile, workspace, extensions directory, and Electron process unless it opts into `sharedLaunch`. */
export const test = base.extend({
  sharedLaunch: [false, { option: true }],
  trustedWorkspace: [true, { option: true }],
  productionRuntime: [false, { option: true }],
  scriptedProvider: [false, { option: true }],
  scriptedAccounts: [undefined, { option: true }],
  workspaceFiles: [{}, { option: true }],
  userSettings: [{}, { option: true }],
  userKeybindings: [[], { option: true }],
  additionalRoots: [[], { option: true }],
  extensionDevelopmentPath: [undefined, { option: true }],
  workerLaunch: [
    async ({}, use, workerInfo) => {
      const slot = {};
      await use(slot);
      await slot.session?.close(workerInfo.parallelIndex);
    },
    { scope: 'worker', timeout: 120_000 },
  ],
  session: async (
    {
      sharedLaunch,
      trustedWorkspace,
      productionRuntime,
      scriptedProvider,
      scriptedAccounts,
      workspaceFiles,
      userSettings,
      userKeybindings,
      additionalRoots,
      extensionDevelopmentPath,
      workerLaunch,
    },
    use,
    testInfo,
  ) => {
    const started = performance.now();
    const options = {
      trustedWorkspace,
      productionRuntime,
      scriptedProvider,
      scriptedAccounts,
      workspaceFiles,
      userSettings,
      userKeybindings,
      additionalRoots,
      extensionDevelopmentPath,
    };
    const shared =
      sharingEnabled && sharedLaunch && !testInfo.annotations.some(({ type }) => type === 'isolated launch');
    let session;
    let launch = 'fresh';
    if (shared && workerLaunch.session) {
      const previous = workerLaunch.session;
      workerLaunch.session = undefined;
      const reason =
        previous.key === JSON.stringify(options)
          ? await previous.reset().catch(error => `reset failed: ${summary(error)}`)
          : 'different launch options';
      if (reason) {
        launch = `fresh (${reason})`;
        await previous.abandon(testInfo);
      } else {
        session = previous;
        launch = 'reused';
      }
    }
    try {
      if (!session) {
        session = new GlyphSession(options);
        await session.start();
      }
      await session.begin();
    } catch (error) {
      await session.finish(testInfo, false);
      throw error;
    }
    testInfo.annotations.push(
      { type: 'glyph launch', description: launch },
      { type: 'glyph setup ms', description: since(started) },
    );
    const body = performance.now();
    await use(session);
    testInfo.annotations.push({ type: 'glyph body ms', description: since(body) });
    const ended = performance.now();
    let discard = shared ? undefined : 'isolated';
    if (!discard && (testInfo.status !== testInfo.expectedStatus || testInfo.errors.length)) discard = 'test failed';
    discard ??= await session.disruption().catch(error => `unhealthy: ${summary(error)}`);
    if (shared && discard) testInfo.annotations.push({ type: 'glyph launch discarded', description: discard });
    if (!discard) workerLaunch.session = session;
    await session.finish(testInfo, !discard);
    testInfo.annotations.push({ type: 'glyph teardown ms', description: since(ended) });
  },
  provider: async ({ session }, use) => {
    if (!session.provider) return use(undefined);
    await use(session.provider);
    session.provider.assertConsumed();
  },
  glyph: async ({ session }, use) => {
    await use(session.glyph);
    expect(await readFile(join(session.workspace, 'example.txt'), 'utf8')).toBe(sentinel);
  },
});

export { expect };
