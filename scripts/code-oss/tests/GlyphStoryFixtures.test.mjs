import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { afterAll, beforeAll, it } from 'vitest';
const requireUpstream = createRequire(new URL('../../../.code-oss/src/package.json', import.meta.url));
const { chromium, expect } = requireUpstream('@playwright/test');
let browser, script;
beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import { h, render } from 'preact';
      import { InteractiveWorkbench } from './code-oss/storybook/InteractiveWorkbench.tsx';
      import { isolateComposer } from './code-oss/storybook/decorators.tsx';
      import workbenchMeta, { AttachedSelection } from './code-oss/ui/GlyphWorkbench/GlyphWorkbench.stories.tsx';
      import composerMeta from './code-oss/ui/GlyphComposer/GlyphComposer.stories.tsx';
      import { conversationFixture, agentMessageFixture, userMessageFixture } from './code-oss/storybook/fixtures/MessageFixtures.ts';
      import { previewActionsFixture } from './code-oss/storybook/fixtures/ActionFixtures.ts';
      const root = document.getElementById('root');
      window.showWorkbench = () => render(h(InteractiveWorkbench, {}), root);
      function ComposerStory({ id }) {
        return isolateComposer(({ args }) => h(composerMeta.component, args), { id, args: composerMeta.args });
      }
      function WorkbenchStory() {
        const args = { ...workbenchMeta.args, ...AttachedSelection.args };
        return isolateComposer(({ args }) => h(workbenchMeta.component, args), { id: 'attached-selection', args });
      }
      window.showWorkbenchStory = () => render(h(WorkbenchStory, {}), root);
      window.showComposer = id => render(h(ComposerStory, { id }), root);
      window.inspectFixtures = () => {
        const first = conversationFixture(), second = conversationFixture();
        first[1].usage.totalTokens = 1;
        const a = previewActionsFixture(), b = previewActionsFixture();
        a.composer.setDraft('Only in the first example');
        const agent = agentMessageFixture({ id: 'custom-turn' });
        const user = userMessageFixture({ checkpointTurnId: agent.id });
        return { secondTokens: second[1].usage.totalTokens, secondDraft: b.composer.snapshot.draft, agentCheckpoint: agent.checkpointTurnId, userCheckpoint: user.checkpointTurnId, userId: user.id };
      };
      window.showWorkbench();
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
});
afterAll(async () => {
  await browser?.close();
});
async function mount() {
  const page = await browser.newPage();
  await page.goto('about:blank');
  await page.setContent('<div id="root" style="height:900px"></div>');
  await page.addScriptTag({ content: script });
  return page;
}
it('shows dates for initial and streamed replies and restores the new turn checkpoint', async () => {
  const page = await mount();
  try {
    const initial = page.locator('.glyph-entry.assistant').first();
    await expect(initial.locator('time')).toHaveAttribute('datetime', '2026-10-19T14:30:00Z');
    await initial.hover();
    await expect(initial.locator('time')).toHaveCSS('opacity', '1');
    const input = page.getByRole('textbox', { name: 'Message Glyph' });
    await input.fill('Check the fixture metadata');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    const reply = page.locator('.glyph-entry.assistant').last();
    await expect(page.locator('.glyph-entry.assistant')).toHaveCount(2);
    await expect(reply.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
    const createdAt = await reply.locator('time').getAttribute('datetime');
    await expect(reply).toContainText('This is a simulated streaming response.');
    await expect(reply.locator('time')).toHaveAttribute('datetime', createdAt);
    await reply.hover();
    await expect(reply.locator('time')).toHaveCSS('opacity', '1');
    await expect(reply.getByRole('button', { name: 'Branch chat' })).toBeVisible();
    await expect(reply).toContainText('No model or workspace is connected.', { timeout: 10000 });
    const request = page.locator('.glyph-entry.user').last();
    await request.hover();
    await request.getByRole('button', { name: 'Restore checkpoint' }).click();
    await expect(page.locator('.glyph-entry.assistant')).toHaveCount(1);
    await expect(input).toHaveText('Check the fixture metadata');
  } finally {
    await page.close();
  }
}, 15000);
it('starts each story with an isolated composer while keeping its draft during rerenders', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => window.showComposer('empty'));
    const input = page.getByRole('textbox', { name: 'Message Glyph' });
    await input.fill('Draft belonging to Empty');
    await page.evaluate(() => window.showComposer('empty'));
    await expect(input).toHaveText('Draft belonging to Empty');
    await page.evaluate(() => window.showComposer('streaming'));
    await expect(input).toHaveText('');
    await page.evaluate(() => window.showComposer('empty'));
    await expect(input).toHaveText('');
    expect(await page.evaluate(() => window.inspectFixtures())).toEqual({
      secondTokens: 13050,
      secondDraft: '',
      agentCheckpoint: 'custom-turn',
      userCheckpoint: 'custom-turn',
      userId: 'custom-turn:user',
    });
  } finally {
    await page.close();
  }
});

it('preserves the complete workbench args when isolating its composer', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => window.showWorkbenchStory());
    await expect(page.locator('.glyph-entry.assistant')).toHaveCount(1);
    await expect(page.locator('.glyph-entry.assistant time')).toHaveAttribute('datetime', '2026-10-19T14:30:00Z');
    await expect(page.getByRole('textbox', { name: 'Message Glyph' })).toContainText('Explain');
  } finally {
    await page.close();
  }
});

it('previews steering as a dark dotted user bubble while the same reply continues', async () => {
  const page = await mount();
  try {
    const input = page.getByRole('textbox', { name: 'Message Glyph' });
    await input.fill('Start the task');
    await input.press('Enter');
    await expect(page.locator('.glyph-entry.assistant')).toHaveCount(2);
    await input.fill('Keep scope small');
    await input.press('ControlOrMeta+Enter');
    const bubble = page.locator('[data-steering="true"]');
    await expect(bubble).toContainText('Keep scope small');
    await expect(bubble).toHaveCSS('border-top-style', 'dotted');
    await expect(input).toHaveText('');
    await expect(page.locator('.glyph-entry.assistant').last()).toContainText(
      'Continuing with your guidance: Keep scope small',
      { timeout: 12000 },
    );
    await expect(page.locator('.glyph-entry.assistant')).toHaveCount(2);
  } finally {
    await page.close();
  }
}, 15000);
