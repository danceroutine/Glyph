import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { buildGlyphDiagram } from '../build-diagram.mjs';
import { afterAll, beforeAll, describe, it } from 'vitest';
const require = createRequire(new URL('../../../.code-oss/src/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
let browser, script, renderer;
async function mount(page) {
  await page.route('http://localhost/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: route.request().url().endsWith('glyph-diagram.html') ? renderer : '<div id="root"></div>',
    }),
  );
  await page.goto('http://localhost/');
  await page.addScriptTag({ content: script });
}
beforeAll(async () => {
  await buildGlyphDiagram('.artifacts/test-diagram');
  renderer = await readFile('.artifacts/test-diagram/glyph-diagram.html', 'utf8');
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { h, render } from 'preact';
    import { MessageActions } from './code-oss/ui/GlyphTranscript/GlyphTranscript.stories.tsx';
    import { WiredGlyphTranscript } from './code-oss/ui/GlyphTranscript/GlyphTranscript.wired.tsx';
    import { WiredGlyphUsageSummary } from './code-oss/ui/GlyphUsageSummary/GlyphUsageSummary.wired.tsx';
    const usage = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 30, reasoningTokens: 12, totalTokens: 130 };
    window.showMessageActions = () => render(h(MessageActions.render, {}), document.getElementById('root'));
    window.actions = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.actions.push(['copy', text]) } });
    const text = '## Result\\n\\n**Strong** and *emphasized*, with [source](src/a.ts).\\n\\n3. Three\\n4. Four\\n\\n> A quotation\\n\\n| Column | Value |\\n| --- | --- |\\n| Test | Passed |\\n\\n\`\`\`mermaid\\nflowchart LR\\n  A[Start] --> B[Done]\\n\`\`\`';
    const entries = [{ id: 'reply', checkpointTurnId: 'turn', role: 'assistant', text, usage, createdAt: '2026-10-17T15:30:00Z' },
      { id: 'context', checkpointTurnId: 'turn', role: 'user', text: '**Compare @a.ts and \`@b.ts\` here**', attachments: [{ path: 'a.ts', text: 'exact', revision: '1' }, { path: 'b.ts', text: 'exact b', revision: '2' }] }];
    const actions = { branchChat: async (chat, turn) => window.actions.push(['branch', chat, turn]), restoreCheckpoint: async (chat, turn) => window.actions.push(['restore', chat, turn]), openLink: async path => window.actions.push(['link', path]), context: { openAttachment: async attachment => window.actions.push(['attachment', attachment.path]) } };
    render(h('div', {}, [h(WiredGlyphTranscript, { entries, actions, chatId: 'chat' }), h(WiredGlyphUsageSummary, { usage })]), document.getElementById('root'));
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

describe('Markdown messages and usage controls', () => {
  it('renders Markdown and Mermaid while preserving inline context and real message actions', async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      await expect(page.getByRole('heading', { name: 'Result' })).toBeVisible();
      await expect(page.locator('ol')).toHaveAttribute('start', '3');
      await expect(page.locator('blockquote')).toHaveText('A quotation');
      await expect(page.getByRole('table')).toContainText('Passed');
      await expect(page.getByRole('img', { name: 'Plan diagram' })).toBeVisible();
      const expand = page.getByRole('button', { name: 'Expand diagram' });
      const bounds = await expand.boundingBox();
      expect(bounds.width).toBe(bounds.height);
      await expand.click();
      await expect(page.getByRole('button', { name: 'Collapse diagram' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(expand).toBeFocused();
      await expect(page.locator('[data-glyph-source="context"] strong button')).toHaveText(['a.ts', 'b.ts']);
      await expect(page.locator('[data-glyph-source="context"] code button')).toHaveText('b.ts');
      await page.getByRole('button', { name: 'Open a.ts' }).click();
      await page.getByRole('link', { name: 'source' }).click();
      await page.getByRole('button', { name: 'Copy message' }).first().click();
      expect(await page.evaluate(() => window.actions.slice(0, 2))).toEqual([
        ['attachment', 'a.ts'],
        ['link', 'src/a.ts'],
      ]);
      expect((await page.evaluate(() => window.actions[2]))[1]).toContain('**Strong**');
      await page.getByRole('button', { name: 'Branch chat' }).click();
      await page.locator('.glyph-entry.user').hover();
      await page.getByRole('button', { name: 'Restore checkpoint' }).click();
      expect(await page.evaluate(() => window.actions.slice(3))).toEqual([
        ['branch', 'chat', 'turn'],
        ['restore', 'chat', 'turn'],
      ]);
      await expect(page.locator('.glyph-entry.user > strong')).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 15000);
  it('shows only icons for turn usage, reveals dates on hover, and dismisses popovers with Escape and outside clicks', async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 1000 } });
    try {
      await mount(page);
      const turn = page.getByRole('button', { name: 'Turn token usage' });
      await expect(turn).toHaveText('');
      const date = page.locator('time');
      await expect(date).toHaveCSS('opacity', '0');
      await page.locator('.glyph-entry.assistant').hover();
      await expect(date).toHaveCSS('opacity', '1');
      await turn.click();
      await expect(page.getByRole('dialog').locator('dd')).toHaveText(['100', '40', '30', '12', '130']);
      const bounds = await page.getByRole('dialog').boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(turn).toBeFocused();
      const conversation = page.getByRole('button', { name: 'Conversation token usage' });
      await expect(conversation).toHaveText('Usage');
      await conversation.click();
      await page.getByRole('heading', { name: 'Result' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 15000);
});

it('shows a date on hover for both assistant messages in the actual Message Actions story', async () => {
  const page = await browser.newPage();
  try {
    await mount(page);
    await page.evaluate(() => window.showMessageActions());
    const messages = page.locator('.glyph-entry.assistant');
    await expect(messages).toHaveCount(2);
    for (const message of await messages.all()) {
      await page.mouse.move(0, 0);
      await expect(message.locator('time')).toHaveCSS('opacity', '0');
      await message.hover();
      await expect(message.locator('time')).toHaveCSS('opacity', '1');
      await expect(message.locator('time')).toHaveAttribute('datetime', /2026-10-18T14:/);
    }
  } finally {
    await page.close();
  }
});
