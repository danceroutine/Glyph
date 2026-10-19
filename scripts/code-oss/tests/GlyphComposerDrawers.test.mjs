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
      import { h, render } from 'preact';
      import { WiredGlyphTodoCard } from './code-oss/ui/GlyphTodoCard/GlyphTodoCard.wired.tsx';
      import { WiredGlyphPendingReviews } from './code-oss/ui/GlyphPendingReviews/GlyphPendingReviews.wired.tsx';
      import { GlyphQueuedMessages } from './code-oss/ui/GlyphQueuedMessages/GlyphQueuedMessages.tsx';
      render(h('div', { id: 'stack', style: 'display:flex;flex-direction:column;height:800px;width:360px' },
        h('div', { style: 'flex:1;min-height:0' }),
        h(WiredGlyphTodoCard, { items: [
          { id: 'a', text: 'Inspect the implementation', status: 'completed' },
          { id: 'b', text: 'Implement the change', status: 'in_progress' },
          { id: 'c', text: 'Verify the result', status: 'pending' },
        ] }),
        h(WiredGlyphPendingReviews, { chatId: 'chat', readOnly: false, proposals: [{ id: 'proposal', chatId: 'chat', files: [
          { id: 'a', path: 'src/one.ts', pendingItemIds: ['a'], applicability: 'ready', textOnly: true },
          { id: 'b', path: 'src/two.ts', pendingItemIds: ['b'], applicability: 'ready', textOnly: true },
        ] }], actions: { reviewProposalFile: async () => {}, decideProposalItems: async () => {} } }),
        h(GlyphQueuedMessages, { state: { queued: [{ id: 'a', text: 'Verify the tests.' }, { id: 'b', text: 'Review the result.' }], active: true, disabled: false } }),
        h('textarea', { 'aria-label': 'Composer', style: 'height:100px;flex-shrink:0' })
      ), document.getElementById('root'));
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

it('aligns the three drawers and animates both directions without moving the composer', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  try {
    await page.setContent(
      '<style>body{margin:0;font:13px Arial}button,textarea{font:inherit}</style><div id="root"></div>',
    );
    await page.addScriptTag({ content: script });
    const cards = ['To-dos', 'Pending reviews', 'Queued messages'].map(name =>
      page.getByRole('region', { name, exact: true }),
    );
    const settle = card =>
      card.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)));
    const toggle = card => card.locator('button[aria-controls]').first();
    const composer = page.getByRole('textbox', { name: 'Composer' });
    for (const width of [280, 360, 600]) {
      await page.locator('#stack').evaluate((el, width) => {
        el.style.width = `${width}px`;
      }, width);
      for (const card of cards) {
        if ((await toggle(card).getAttribute('aria-expanded')) !== 'true') await toggle(card).click();
        await settle(card);
      }
      const composerTop = (await composer.boundingBox()).y;
      for (const expanded of [false, true]) {
        for (const card of cards) {
          // Pause halfway through the real CSS transition to prove the rows move
          // progressively, rather than only checking their final visibility.
          const motion = await card.evaluate(async (el, expanded) => {
            const panel = el.querySelector(':scope > div[aria-hidden]');
            const before = panel.getBoundingClientRect().height;
            el.querySelector('button[aria-controls]').click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            panel.getBoundingClientRect();
            const animation = panel.getAnimations()[0];
            if (!animation) throw new Error(`${el.getAttribute('aria-label')} changed height without an animation`);
            animation.pause();
            animation.currentTime = 90;
            const middle = panel.getBoundingClientRect().height;
            animation.finish();
            const after = panel.getBoundingClientRect().height;
            return { before, middle, after, expanded };
          }, expanded);
          expect(motion.middle).toBeGreaterThan(Math.min(motion.before, motion.after));
          expect(motion.middle).toBeLessThan(Math.max(motion.before, motion.after));
          expect(motion.after > motion.before).toBe(expanded);
          await settle(card);
          await expect(toggle(card)).toHaveAttribute('aria-expanded', String(expanded));
          await expect(card.getByRole('list')).toHaveCount(expanded ? 1 : 0);
          expect((await composer.boundingBox()).y).toBe(composerTop);
        }
        const geometry = await Promise.all(
          cards.map(card =>
            card.evaluate(el => {
              const toggle = el.querySelector('button[aria-controls]');
              const svg = toggle.querySelector('svg');
              const bounds = el.getBoundingClientRect();
              const icon = svg.getBoundingClientRect();
              const label =
                toggle.querySelector('span') ??
                [...toggle.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
              const range = document.createRange();
              range.selectNodeContents(label);
              return {
                x: icon.x,
                labelX: range.getBoundingClientRect().x,
                inset: icon.x - bounds.x - parseFloat(getComputedStyle(el).borderLeftWidth),
                width: icon.width,
                transform: getComputedStyle(svg).transform,
                shape: svg.innerHTML,
              };
            }),
          ),
        );
        expect(new Set(geometry.map(value => value.x)).size).toBe(1);
        expect(new Set(geometry.map(value => value.labelX)).size).toBe(1);
        expect(new Set(geometry.map(value => value.transform)).size).toBe(1);
        expect(new Set(geometry.map(value => value.shape)).size).toBe(1);
        for (const value of geometry) {
          expect(value.inset).toBe(12);
          expect(value.width).toBe(16);
        }
        const review = await cards[1].getByRole('button', { name: 'Review', exact: true }).boundingBox();
        const panel = await cards[1].boundingBox();
        const border = await cards[1].evaluate(el => parseFloat(getComputedStyle(el).borderRightWidth));
        expect(panel.x + panel.width - review.x - review.width - border).toBe(12);
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const card of cards) {
      await toggle(card).click();
      expect(await card.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
      await expect(card.getByRole('list')).toHaveCount(0);
    }
  } finally {
    await page.close();
  }
}, 15000);
