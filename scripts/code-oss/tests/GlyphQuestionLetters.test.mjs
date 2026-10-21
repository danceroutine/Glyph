import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { it } from 'vitest';
import { coverageBuildOptions, newCoveredPage } from '#scripts/code-oss/tests/support/coverage.mjs';
const require = createRequire(new URL('../../../.code-oss/src/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');

it('uses letter controls for choices and Other while retaining radio keyboard and free-text behavior', async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { h, render } from 'preact';
        import { WiredGlyphWorkbench } from './code-oss/ui/GlyphWorkbench/GlyphWorkbench.wired.tsx';
        import stories from './code-oss/ui/GlyphWorkbench/GlyphInteractions.stories.tsx';
        render(h(WiredGlyphWorkbench, stories.args), document.getElementById('root'));
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    ...coverageBuildOptions,
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
  });
  const browser = await chromium.launch();
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: result.outputFiles[0].text });
    const first = page.getByRole('group').nth(0);
    const second = page.getByRole('group').nth(1);
    const choices = first.getByRole('radio');
    await expect(choices).toHaveCount(4);
    expect(await choices.evaluateAll(inputs => inputs.map(input => input.nextElementSibling.textContent))).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
    await expect(choices.first()).toHaveCSS('opacity', '0');
    await page.getByRole('radio', { name: 'TypeScript' }).check();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: 'Rust' })).toBeChecked();
    await first.getByRole('radio', { name: 'Other…' }).check();
    await page.getByRole('textbox', { name: 'Your answer' }).fill('Swift');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(2);
    await page.getByRole('checkbox', { name: 'Clarity' }).check();
    await page.getByRole('checkbox', { name: 'Speed' }).check();
    await expect(page.getByRole('checkbox', { name: 'Clarity' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Speed' })).toBeChecked();
    await expect(second.getByRole('radio', { name: 'Other…' }).locator('..')).toContainText('C');
  } finally {
    await page.close();
    await browser.close();
  }
}, 30000);
