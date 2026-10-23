import { build } from 'esbuild';
import { afterAll, beforeAll, it } from 'vitest';
import { coverageBuildOptions, newCoveredPage } from '#scripts/code-oss/tests/support/coverage.mjs';
import { chromium, expect } from '#scripts/code-oss/tests/support/playwright.mjs';
/** @type {import('@playwright/test').Browser} */
let browser;
/** @type {string} */
let script;
beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import { h, render } from 'preact';
      import { Button, IconButton, ButtonVariant as V, ButtonAppearance as A, IconButtonShape as S } from './code-oss/ui/Button/Button.tsx';
      import { SplitButton } from './code-oss/ui/Button/SplitButton.tsx';
      import { AgentModeID } from './src/chat/AgentMode.ts';
      import { stageClassName } from './code-oss/storybook/previewStyles.ts';
      const root = document.getElementById('root'); root.className = stageClassName; root.dataset.theme = 'dark';
      window.clicks = []; window.submits = 0;
      render(h('form', {onSubmit: e => { e.preventDefault(); window.submits++; }},
        h(Button, {variant: V.PRIMARY, onClick: () => window.clicks.push('primary')}, 'Primary'),
        h(Button, {variant: V.PRIMARY, mode: AgentModeID.PLAN}, 'Plan'),
        h(Button, {variant: V.CONFIRM, appearance: A.OUTLINE, shortcut: 'configured shortcut'}, 'Confirm'),
        h(Button, {loading: true, onClick: () => window.clicks.push('loading')}, 'Loading'),
        h(IconButton, {'aria-label': 'Loading icon', loading: true}, h('svg')),
        h(Button, {type: 'submit'}, 'Submit'),
        h(IconButton, {'aria-label': 'Circular action', shape: S.CIRCLE, onClick: () => window.clicks.push('icon')}, h('svg')),
        h(SplitButton, {menuLabel: 'More actions', onClick: () => window.clicks.push('build'),
          menu: h(Button, {onClick: () => window.clicks.push('alternate')}, 'Alternate')}, 'Build')
      ), root);
    `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    ...coverageBuildOptions,
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 30000);
afterAll(async () => {
  await browser?.close();
});
it('preserves native form behavior, keyboard activation, and disabled loading actions', async () => {
  const page = await newCoveredPage(browser);
  page.setDefaultTimeout(2500);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const primary = page.getByRole('button', { name: 'Primary', exact: true });
    await primary.focus();
    await primary.press('Enter');
    await expect(primary).toHaveCSS('outline-style', 'solid');
    expect(await page.evaluate(() => window.submits)).toBe(0);
    await expect(page.getByRole('button', { name: 'Loading', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Loading', exact: true })).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'Loading icon', exact: true }).locator('svg')).toHaveCount(1);
    const icon = page.getByRole('button', { name: 'Circular action' });
    await icon.focus();
    await icon.press('Space');
    await expect(icon).toHaveCSS('border-radius', '50%');
    expect(await page.evaluate(() => window.clicks)).toEqual(['primary', 'icon']);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    expect(await page.evaluate(() => window.submits)).toBe(1);
  } finally {
    await page.close();
  }
});
it('uses mode colors while outline keeps neutral text in both themes', async () => {
  const page = await newCoveredPage(browser);
  page.setDefaultTimeout(2500);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    for (const theme of ['dark', 'light']) {
      await page.locator('#root').evaluate((el, t) => (el.dataset.theme = t), theme);
      const colors = await page.getByRole('button').evaluateAll(buttons =>
        buttons.slice(0, 3).map(el => {
          const c = getComputedStyle(el);
          return { background: c.backgroundColor, color: c.color, border: c.borderTopColor };
        }),
      );
      expect(colors[0].background).not.toBe(colors[1].background);
      expect(colors[1].color).toBe('rgb(24, 24, 24)');
      expect(colors[2].background).toBe('rgba(0, 0, 0, 0)');
      expect(colors[2].border).not.toBe(colors[2].color);
      await expect(page.getByText('configured shortcut')).toBeVisible();
    }
  } finally {
    await page.close();
  }
});
it('opens split options by keyboard, restores focus on Escape and runs the alternate action', async () => {
  const page = await newCoveredPage(browser);
  page.setDefaultTimeout(2500);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const toggle = page.getByRole('button', { name: 'More actions' });
    await toggle.focus();
    await toggle.press('Enter');
    await expect(page.getByRole('button', { name: 'Alternate' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await page.getByRole('button', { name: 'Alternate' }).click();
    expect(await page.evaluate(() => window.clicks)).toEqual(['alternate']);
    expect(await page.evaluate(() => window.submits)).toBe(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await page.close();
  }
});
