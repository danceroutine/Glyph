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
      import { h, render } from 'preact';
      import { WiredGlyphTodoCard } from './code-oss/ui/GlyphTodoCard/GlyphTodoCard.wired.tsx';
      import { WiredGlyphPendingReviews } from './code-oss/ui/GlyphPendingReviews/GlyphPendingReviews.wired.tsx';
      import { GlyphBackgroundTerminals } from './code-oss/ui/GlyphBackgroundTerminals/GlyphBackgroundTerminals.tsx';
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
        h(GlyphBackgroundTerminals, { shells: [{ id: 'terminal', chatId: 'chat', command: 'Background ticker', output: 'tick', workingDirectory: '/project', running: true, wakePattern: 'READY' }], open: async () => { window.opened = true; }, stop: async () => { throw new Error('Stop failed'); } }),
        h(GlyphQueuedMessages, { state: { queued: [{ id: 'a', text: 'Verify the tests.' }, { id: 'b', text: 'Review the result.' }], active: true, disabled: false } }),
        h('textarea', { 'aria-label': 'Composer', style: 'height:100px;flex-shrink:0' })
      ), document.getElementById('root'));
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

it('aligns all four drawers and animates both directions without moving the composer', async () => {
  const page = await newCoveredPage(browser, { viewport: { width: 1000, height: 1000 } });
  page.setDefaultTimeout(3000);
  try {
    await page.setContent(
      '<style>body{margin:0;font:13px Arial}button,textarea{font:inherit}</style><div id="root"></div>',
    );
    await page.addScriptTag({ content: script });
    const cards = ['To-dos', 'Pending reviews', 'Background terminals', 'Queued messages'].map(name =>
      page.getByRole('region', { name, exact: true }),
    );
    /** @param {import('@playwright/test').Locator} card */
    const settle = async card => {
      await card.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)));
    };
    /** @param {import('@playwright/test').Locator} card */
    const toggle = card => card.locator('button[aria-controls]').first();
    const composer = page.getByRole('textbox', { name: 'Composer' });
    for (const width of [280, 360, 600]) {
      await page.locator('#stack').evaluate((el, targetWidth) => {
        el.style.width = `${targetWidth}px`;
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
          const motion = await card.evaluate(async (el, wasExpanded) => {
            const panel = el.querySelector(':scope > div[aria-hidden]');
            const button = el.querySelector('button[aria-controls]');
            if (panel === null || !(button instanceof HTMLElement)) throw new TypeError('Expected a drawer toggle.');
            const before = panel.getBoundingClientRect().height;
            button.click();
            await new Promise(resolve => {
              requestAnimationFrame(() => {
                requestAnimationFrame(resolve);
              });
            });
            panel.getBoundingClientRect();
            const animation = panel.getAnimations().at(0);
            if (animation === undefined)
              throw new Error(`${el.getAttribute('aria-label')} changed height without an animation`);
            animation.pause();
            animation.currentTime = 90;
            const middle = panel.getBoundingClientRect().height;
            animation.finish();
            const after = panel.getBoundingClientRect().height;
            return { before, middle, after, expanded: wasExpanded };
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
              const button = el.querySelector('button[aria-controls]');
              const svg = button.querySelector('svg');
              const bounds = el.getBoundingClientRect();
              const icon = svg.getBoundingClientRect();
              const label =
                button.querySelector('span') ??
                [...button.childNodes].find(
                  node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
                );
              const range = document.createRange();
              range.selectNodeContents(label);
              return {
                x: icon.x,
                labelX: range.getBoundingClientRect().x,
                inset: icon.x - bounds.x - Number(getComputedStyle(el).borderLeftWidth.replace(/px$/u, '')),
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
        const border = await cards[1].evaluate(el => Number(getComputedStyle(el).borderRightWidth.replace(/px$/u, '')));
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

it('opens a background terminal and keeps a failed Stop visible for retry', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const terminals = page.getByRole('region', { name: 'Background terminals' });
    await terminals.getByRole('button', { name: '1 background terminal', exact: true }).press('Enter');
    await expect(terminals.getByRole('listitem')).toContainText('Wake on: READY');
    await terminals.getByRole('button', { name: 'Background ticker', exact: true }).click();
    expect(await page.evaluate(() => window.opened)).toBe(true);
    await terminals.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(terminals.getByRole('alert')).toHaveText('Stop failed');
    await expect(terminals.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  } finally {
    await page.close();
  }
});
