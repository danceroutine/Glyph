import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { afterAll, beforeAll, it } from 'vitest';
const require = createRequire(new URL('../../../.code-oss/src/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
let browser, script;
beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import { h, render } from 'preact';
      import { WiredGlyphAgentMessage } from './code-oss/ui/GlyphAgentMessage/GlyphAgentMessage.wired.tsx';
      import { WiredGlyphTranscript } from './code-oss/ui/GlyphTranscript/GlyphTranscript.wired.tsx';
      import { CompleteTurn } from './code-oss/ui/GlyphAgentMessage/GlyphAgentMessage.stories.tsx';
      import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';
      const root = document.getElementById('root');
      const entry = CompleteTurn.args.entry;
      window.calls = [];
      const actions = { ...previewActionsFixture(),
        copyText: async text => window.calls.push(['copy', text]),
        branchChat: async (chat, turn) => { window.calls.push(['branch', chat, turn]); await new Promise(resolve => window.finishBranch = resolve); },
        decideApproval: async (...args) => window.calls.push(['approval', ...args]),
      };
      window.show = (transcript = false, streaming = false, readOnly = false) => {
        const message = { ...entry, text: entry.text + (streaming ? '\\nAdditional streamed text.' : '') };
        render(transcript ? h(WiredGlyphTranscript, { entries: [message, { ...message, id: 'second', checkpointTurnId: 'second' }], actions, chatId: 'chat', readOnly }) : h(WiredGlyphAgentMessage, { entry: message, actions, chatId: 'chat', readOnly }), root);
      };
      window.approval = (runId, readOnly = false) => render(h(WiredGlyphAgentMessage, {
        entry, actions, chatId: 'chat', readOnly,
        pendingApproval: { runId, chatId: 'chat', approval: { id: 'approval', title: 'Allow shell command?', detail: 'pnpm test', command: 'pnpm test', workingDirectory: '/workspace/glyph', sandboxed: true, canRemember: true } },
      }), root);
      window.show();
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
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: script });
  return page;
}
it('renders a complete standalone agent message and retains code controls during streaming', async () => {
  const page = await mount();
  try {
    await expect(page.getByRole('log')).toHaveCount(0);
    await expect(page.locator('.glyph-entry.assistant')).toHaveCount(1);
    await expect(page.getByText('Vitest, node:test', { exact: true })).toBeVisible();
    await expect(page.getByText('All queue tests passed.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Turn token usage' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Branch chat' })).toBeVisible();
    await expect(page.getByText('pnpm test -- GlyphComposerState', { exact: true })).toBeVisible();
    const wrap = page.getByRole('button', { name: 'Wrap code' });
    await wrap.click();
    await page.evaluate(() => {
      window.messageNode = document.querySelector('.glyph-entry.assistant');
      window.show(false, true);
    });
    expect(await page.evaluate(() => window.messageNode === document.querySelector('.glyph-entry.assistant'))).toBe(
      true,
    );
    await expect(wrap).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Copy message', exact: true }).click();
    expect((await page.evaluate(() => window.calls))[0][1]).toContain('Additional streamed text.');
    await page.evaluate(() => window.show(false, true, true));
    await expect(page.getByRole('button', { name: 'Branch chat' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy message', exact: true })).toBeEnabled();
  } finally {
    await page.close();
  }
});
it('shares the history action lock across extracted messages in a transcript', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => window.show(true));
    await expect(page.getByRole('log')).toHaveCount(1);
    const branches = page.getByRole('button', { name: 'Branch chat' });
    await expect(branches).toHaveCount(2);
    await branches.first().click();
    await expect(branches.first()).toBeDisabled();
    await expect(branches.last()).toBeDisabled();
    await page.evaluate(() => window.finishBranch());
    await expect(branches.last()).toBeEnabled();
    expect(await page.evaluate(() => window.calls)).toEqual([['branch', 'chat', 'run']]);
  } finally {
    await page.close();
  }
});
it('routes approval only to its owning message and disables decisions in a read-only view', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => window.approval('other-run'));
    await expect(page.getByText('Allow shell command?', { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.approval('run', true));
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
    await page.evaluate(() => window.approval('run'));
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    expect((await page.evaluate(() => window.calls))[0]).toEqual(['approval', 'chat', 'run', 'approval', 'allow_once']);
  } finally {
    await page.close();
  }
});
