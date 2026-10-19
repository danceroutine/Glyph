import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { beforeAll, afterAll, it } from 'vitest';
const { chromium, expect } = createRequire(new URL('../../../.code-oss/src/package.json', import.meta.url))(
  '@playwright/test',
);
let browser, script;
beforeAll(async () => {
  script = (
    await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
    import { render, h } from 'preact';
    import { WiredGlyphPendingReviews } from './code-oss/ui/GlyphPendingReviews/GlyphPendingReviews.wired.tsx';
    let props = { chatId: 'one', readOnly: false, proposals: [
      { id: 'ours', chatId: 'one', files: [{ id: 'a', path: 'src/<script>.ts', pendingItemIds: ['a1', 'a2'], applicability: 'ready', textOnly: true, additions: 2, deletions: 1 }] },
      { id: 'theirs', chatId: 'two', files: [{ id: 'b', path: 'secret.ts', pendingItemIds: ['b1'], applicability: 'ready', textOnly: true }] },
    ], actions: { reviewProposalFile: async () => {}, decideProposalItems: async (...args) => {
      window.decisions.push(args); await new Promise((resolve, reject) => { window.finish = resolve; window.fail = reject; });
    } } };
    window.decisions = [];
    window.update = next => { props = { ...props, ...next }; render(h(WiredGlyphPendingReviews, props), document.getElementById('root')); };
    window.update();
  `,
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"' },
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
    })
  ).outputFiles[0].text;
  browser = await chromium.launch();
}, 30000);
afterAll(async () => {
  await browser?.close();
});

it('keeps review actions scoped, keyboard accessible, pending until acknowledged and retryable on failure', async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  try {
    await page.setContent(
      '<div id="root" style="width:280px;--vscode-foreground:#ccc;--vscode-descriptionForeground:#999;--vscode-toolbar-hoverBackground:#333"></div>',
    );
    await page.addScriptTag({ content: script });
    const card = page.getByRole('region', { name: 'Pending reviews' });
    await expect(card).toContainText('1 File');
    await expect(card).not.toContainText('secret.ts');
    await expect(card.locator('script')).toHaveCount(0);
    const disclosure = card.locator('summary');
    const count = disclosure.locator('.glyph-review-count');
    await expect(count).toHaveCSS('color', 'rgb(153, 153, 153)');
    await count.hover();
    await expect(count).toHaveCSS('color', 'rgb(204, 204, 204)');
    await expect(count).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(disclosure).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const file = card.getByRole('button', { name: 'Review src/<script>.ts', exact: true });
    await expect(file).toHaveAttribute('title', 'src/<script>.ts');
    await expect(card.locator('.glyph-file-actions')).toHaveCSS('opacity', '0');
    await file.focus();
    await expect(card.locator('.glyph-file-actions')).toHaveCSS('opacity', '1');
    const undo = card.getByRole('button', { name: 'Undo src/<script>.ts', exact: true });
    const keep = card.getByRole('button', { name: 'Keep src/<script>.ts', exact: true });
    await expect(undo.locator('svg')).toHaveCount(1);
    await expect(keep.locator('svg')).toHaveCount(1);
    await undo.hover();
    await expect(undo).toHaveCSS('background-color', 'rgb(51, 51, 51)');
    await expect(undo).toHaveCSS('color', 'rgb(204, 204, 204)');
    await keep.hover();
    await expect(keep).toHaveCSS('background-color', 'rgb(51, 51, 51)');
    await expect(keep).toHaveCSS('color', 'rgb(204, 204, 204)');
    await card.getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.decisions)).toEqual([
      [
        'one',
        [
          { proposalId: 'ours', itemId: 'a1' },
          { proposalId: 'ours', itemId: 'a2' },
        ],
        true,
      ],
    ]);
    await page.evaluate(() => window.fail(new TypeError('Fixture failure')));
    await expect(card.getByRole('alert')).toHaveText('Fixture failure');
    await card.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.evaluate(() => window.finish());
    await expect(card.getByRole('button', { name: 'Keep', exact: true })).toBeEnabled();
    await page.evaluate(() => window.update({ readOnly: true }));
    await expect(card.getByRole('button', { name: 'Keep', exact: true })).toBeDisabled();
    await card.locator('summary').press('Enter');
    await expect(card.getByRole('list')).toHaveCount(0);
    await disclosure.press('Space');
    await expect(card.getByRole('list')).toBeVisible();
  } finally {
    await page.close();
  }
});
