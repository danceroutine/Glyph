import { build } from 'esbuild';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { chromium, expect } from '#scripts/code-oss/tests/support/playwright.mjs';
/** @type {import('@playwright/test').Browser} */
let browser;
/** @type {string} */
let script;
/** @param {import('@playwright/test').Page} page @param {boolean} building */
async function mount(page, building) {
  await page.route('http://localhost/**', route =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost/');
  await page.addScriptTag({ content: script });
  await page.evaluate(value => window.showTranscript(value), building);
}
beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { h, render } from 'preact';
    import { planBuildConversationFixture } from './code-oss/storybook/fixtures/MessageFixtures.ts';
    import { WiredGlyphTranscript } from './code-oss/ui/GlyphTranscript/GlyphTranscript.wired.tsx';
    window.actions = [];
    const actions = { restoreCheckpoint: async (chat, turn) => window.actions.push(['restore', chat, turn]) };
    window.showTranscript = building => render(
      h('div', { style: 'height: 360px; display: flex; flex-direction: column' },
        h(WiredGlyphTranscript, {
          entries: planBuildConversationFixture(),
          actions,
          chatId: 'chat',
          buildingPlanIds: building ? ['plan'] : [],
          openPlan: (chat, plan) => window.actions.push(['open', chat, plan]),
        })),
      document.getElementById('root'));
  `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 30000);
afterAll(async () => {
  await browser?.close();
});

describe('Plan build orders in the transcript', () => {
  it('shows the plan’s todos above the build order and opens the plan from it', async () => {
    const page = await browser.newPage();
    try {
      await mount(page, false);
      const order = page.locator('.glyph-plan-build');
      const todos = order.getByRole('list', { name: 'Todo items' });
      const open = order.getByRole('button', { name: 'Build Queue composer messages. Open plan' });
      await expect(todos.getByRole('listitem')).toHaveCount(4);
      await expect(order).not.toContainText('Build this approved plan');
      expect((await todos.boundingBox()).y).toBeLessThan((await open.boundingBox()).y);
      await open.click();
      await order.hover();
      await order.getByRole('button', { name: 'Restore checkpoint' }).click();
      expect(await page.evaluate(() => window.actions)).toEqual([
        ['open', 'chat', 'plan'],
        ['restore', 'chat', 'build'],
      ]);
    } finally {
      await page.close();
    }
  });

  it('pins the build order to the top of the chat without its todos while the plan is building', async () => {
    const page = await browser.newPage();
    try {
      await mount(page, true);
      const transcript = page.locator('.glyph-transcript');
      const order = page.locator('.glyph-plan-build');
      await transcript.evaluate(element => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(order.getByRole('list', { name: 'Todo items' })).toHaveCount(0);
      await expect(order.getByRole('button', { name: 'Build Queue composer messages. Open plan' })).toBeInViewport();
      expect((await order.boundingBox()).y).toBe((await transcript.boundingBox()).y);
    } finally {
      await page.close();
    }
  });

  it('marks a message sent during the build with the build’s progress at that moment', async () => {
    const page = await browser.newPage();
    try {
      await mount(page, true);
      const rider = page.getByRole('note', { name: /^Sent while building Queue composer messages/u });
      await expect(rider).toContainText('Send the next queued message when a run completes');
      await expect(rider).toContainText('1/4');
    } finally {
      await page.close();
    }
  });
});
