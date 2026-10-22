import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as base } from './playwright.mjs';
import { GlyphSession, sentinel } from './GlyphSession.mjs';

const sharingEnabled = process.env.GLYPH_ELECTRON_SHARED_LAUNCH !== '0';
/** @param {number} start */
const since = start => String(Math.round(performance.now() - start));
/** @param {unknown} error */
const summary = error =>
  (error instanceof Error ? error.message : String(error))
    .replaceAll(/\u001B\[\d+m/gu, '')
    .split('\n')
    .filter(line => /\S/u.test(line) && !line.includes('Call log'))
    .slice(0, 3)
    .join(' ')
    .slice(0, 300);

/** @param {string} reason */
export const isolatedLaunch = reason => ({ annotation: { type: 'isolated launch', description: reason } });

/**
 * @typedef {import('@playwright/test')} Playwright
 * @typedef {ConstructorParameters<typeof GlyphSession>[0]} GlyphLaunchOptions
 * @typedef {GlyphLaunchOptions & {
 *   sharedLaunch: boolean,
 *   session: GlyphSession,
 *   provider: GlyphSession['provider'],
 *   glyph: import('./GlyphWorkbench.mjs').GlyphWorkbench,
 * }} GlyphTestFixtures
 * @typedef {{ workerLaunch: { session?: GlyphSession | undefined } }} GlyphWorkerFixtures
 */

/**
 * Each test owns a fresh profile, workspace, extensions directory, and Electron process unless it opts into `sharedLaunch`.
 * @type {import('@playwright/test').Fixtures<
 *   GlyphTestFixtures,
 *   GlyphWorkerFixtures,
 *   import('@playwright/test').PlaywrightTestArgs &
 *     import('@playwright/test').PlaywrightTestOptions,
 *   import('@playwright/test').PlaywrightWorkerArgs &
 *     import('@playwright/test').PlaywrightWorkerOptions
 * >}
 */
const fixtures = {
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
      /** @type {GlyphWorkerFixtures['workerLaunch']} */
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
      if (reason !== undefined && reason !== '') {
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
    if (
      (discard === undefined || discard === '') &&
      (testInfo.status !== testInfo.expectedStatus || testInfo.errors.length > 0)
    )
      discard = 'test failed';
    discard ??= await session.disruption().catch(error => `unhealthy: ${summary(error)}`);
    if (shared && discard !== undefined && discard !== '')
      testInfo.annotations.push({ type: 'glyph launch discarded', description: discard });
    if (discard === undefined || discard === '') workerLaunch.session = session;
    await session.finish(testInfo, discard === undefined || discard === '');
    testInfo.annotations.push({ type: 'glyph teardown ms', description: since(ended) });
  },
  provider: async ({ session }, use) => {
    if (!session.provider) return use(undefined);
    await use(session.provider);
    session.provider.assertConsumed();
  },
  glyph: async ({ session }, use) => {
    const { glyph } = session;
    if (glyph === undefined) throw new Error('The Glyph session has not begun.');
    await use(glyph);
    expect(await readFile(join(session.workspace, 'example.txt'), 'utf8')).toBe(sentinel);
  },
};

export const test = base.extend(fixtures);

export { expect };
