import { build } from 'esbuild';
import { beforeAll, afterAll, it } from 'vitest';
import { coverageBuildOptions, newCoveredPage } from '#scripts/code-oss/tests/support/coverage.mjs';
import { chromium, expect } from '#scripts/code-oss/tests/support/playwright.mjs';
/** @type {import('@playwright/test').Browser} */
let browser;
/** @type {string} */
let script;
beforeAll(async () => {
  script = (
    await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
        import { render, h } from 'preact';
        import { WiredGlyphTodoCard } from './code-oss/ui/GlyphTodoCard/GlyphTodoCard.wired.tsx';
        let items = [
          { id: 'a', text: '<script>alert(1)</script>', status: 'completed' },
          { id: 'b', text: 'Current work', status: 'in_progress' },
          { id: 'c', text: 'Next work', status: 'pending' },
        ];
        window.update = next => {
          items = next ?? items;
          render(h('div', { style: 'display:flex;flex-direction:column;height:600px;width:300px' },
            h('div', { style: 'flex:1;min-height:0;overflow:auto' }, 'Transcript'),
            h(WiredGlyphTodoCard, { items }),
            h('textarea', { 'aria-label': 'Composer', style: 'height:80px;flex-shrink:0' })), document.getElementById('root'));
        };
        window.update();
      `,
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      ...coverageBuildOptions,
      define: { 'process.env.NODE_ENV': '"production"' },
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
    })
  ).outputFiles[0].text;
  browser = await chromium.launch();
}, 30000);
afterAll(async () => {
  await browser?.close();
});

it('opens upward like a drawer with keyboard access, keeps items read-only, and derives live counts', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const card = page.getByRole('region', { name: 'To-dos' });
    const toggle = card.getByRole('button', { name: '1 of 3 To-dos completed' });
    const before = await toggle.boundingBox();
    const cardBefore = await card.boundingBox();
    const composerBefore = await page.getByRole('textbox', { name: 'Composer' }).boundingBox();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await card.evaluate(element =>
      Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)),
    );
    await expect(card.getByRole('listitem')).toHaveCount(3);
    await expect(card.getByRole('listitem').first()).toContainText('<script>alert(1)</script>');
    await expect(card.getByRole('listitem')).toHaveText(['<script>alert(1)</script>', 'Current work', 'Next work']);
    for (const status of ['Completed', 'In progress', 'Pending'])
      await expect(card.getByRole('img', { name: status, exact: true })).toBeVisible();
    await expect(card.locator('script, input, textarea, [contenteditable]')).toHaveCount(0);
    expect((await card.getByRole('list').boundingBox()).y).toBeLessThan(before.y);
    const openToggle = await toggle.boundingBox();
    const openList = await card.getByRole('list').boundingBox();
    const openCard = await card.boundingBox();
    expect(openToggle.y).toBeLessThan(before.y);
    expect(Math.abs(openToggle.y + openToggle.height - openList.y)).toBeLessThan(2);
    expect(Math.abs(openCard.y + openCard.height - (cardBefore.y + cardBefore.height))).toBeLessThan(2);
    expect((await page.getByRole('textbox', { name: 'Composer' }).boundingBox()).y).toBe(composerBefore.y);
    await page.evaluate(() =>
      window.update(
        Array.from({ length: 39 }, (_, i) => ({
          id: String(i),
          text: 'A long task description with details that wrap within a narrow sidebar',
          status: i < 30 ? 'completed' : 'pending',
        })),
      ),
    );
    await expect(card.getByRole('button', { name: '30 of 39 To-dos completed' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(card.getByRole('listitem')).toHaveCount(39);
    expect(await card.getByRole('list').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect((await page.getByRole('textbox', { name: 'Composer' }).boundingBox()).y).toBe(composerBefore.y);
    await page.keyboard.press('Space');
    await expect(card.getByRole('list')).toHaveCount(0);
  } finally {
    await page.close();
  }
});
