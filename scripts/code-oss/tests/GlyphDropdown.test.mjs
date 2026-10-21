import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { afterAll, beforeAll, it } from 'vitest';
import { coverageBuildOptions, newCoveredPage } from '#scripts/code-oss/tests/support/coverage.mjs';
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
    import { GlyphModelPicker } from './code-oss/ui/GlyphModelPicker/GlyphModelPicker.presentational.tsx';
    let model = '0', disabled = false;
    let models = Array.from({ length: 40 }, (_, index) => ({ value: String(index), label: 'Model ' + String(index).padStart(2, '0') }));
    window.changes = [];
    const update = () => render(h(GlyphModelPicker, { model, models, label: models.find(item => item.value === model)?.label ?? 'No model', disabled,
      selectModel: value => { window.changes.push(value); model = value; update(); },
    }), document.getElementById('root'));
    window.configure = patch => { if ('disabled' in patch) disabled = patch.disabled; if (patch.models) models = patch.models; update(); };
    update();
  `,
      },
      bundle: true,
      write: false,
      platform: 'browser',
      ...coverageBuildOptions,
      format: 'iife',
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
    })
  ).outputFiles[0].text;
  browser = await chromium.launch();
}, 30000);
afterAll(async () => {
  await browser?.close();
});
async function openPage() {
  const page = await newCoveredPage(browser, { viewport: { width: 600, height: 700 } });
  page.setDefaultTimeout(2000);
  await page.setContent(
    '<div id="root" style="position:absolute;top:620px;left:450px;width:130px"></div><button id="after">After</button>',
  );
  await page.addScriptTag({ content: script });
  return page;
}
it('keeps focus on the trigger, separates highlight from selection, scrolls and commits by keyboard', async () => {
  const page = await openPage();
  try {
    const trigger = page.getByRole('combobox', { name: 'Model' });
    await trigger.focus();
    await trigger.press('Enter');
    await expect(trigger).toBeFocused();
    const selected = page.getByRole('option', { name: 'Model 00', exact: true });
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    await trigger.press('End');
    const last = page.getByRole('option', { name: 'Model 39', exact: true });
    await expect(last).toHaveAttribute('data-highlighted', 'true');
    await expect(last).toHaveAttribute('aria-selected', 'false');
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(await page.getByRole('listbox').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect(trigger).toHaveAttribute('aria-activedescendant', await last.getAttribute('id'));
    await trigger.press('Enter');
    await expect(trigger).toHaveText('Model 39');
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.changes)).toEqual(['39']);
    await trigger.press('ArrowUp');
    await trigger.press('Home');
    await trigger.press('Escape');
    await expect(trigger).toHaveText('Model 39');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await trigger.click();
    await trigger.press('Tab');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page.locator('#after')).toBeFocused();
  } finally {
    await page.close();
  }
});
it('supports typeahead, pointer selection and outside dismissal, and closes when disabled', async () => {
  const page = await openPage();
  try {
    await page.evaluate(() =>
      window.configure({
        models: [
          { value: '0', label: 'Auto' },
          { value: '1', label: 'Fast' },
          { value: '2', label: 'Focused' },
          { value: '3', label: 'Thorough' },
        ],
      }),
    );
    const trigger = page.getByRole('combobox', { name: 'Model' });
    await trigger.focus();
    await trigger.press('f');
    await expect(page.getByRole('option', { name: 'Fast', exact: true })).toHaveAttribute('data-highlighted', 'true');
    await trigger.press('f');
    await expect(page.getByRole('option', { name: 'Focused', exact: true })).toHaveAttribute(
      'data-highlighted',
      'true',
    );
    await trigger.press('Enter');
    await expect(trigger).toHaveText('Focused');
    await trigger.click();
    await page.getByRole('option', { name: 'Thorough' }).hover();
    await expect(trigger).toBeFocused();
    await trigger.press('Enter');
    await expect(trigger).toHaveText('Thorough');
    await trigger.click();
    await page.locator('#after').click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await trigger.click();
    await page.evaluate(() => window.configure({ disabled: true }));
    await expect(trigger).toBeDisabled();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await page.evaluate(() => window.configure({ disabled: false }));
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => window.changes)).toEqual(['2', '3']);
  } finally {
    await page.close();
  }
});
it('clamps to the viewport and flips below an anchor near the top', async () => {
  const page = await openPage();
  try {
    const trigger = page.getByRole('combobox', { name: 'Model' });
    await trigger.click();
    const popup = page.locator('[data-dropdown]');
    await expect(popup).toHaveCSS('width', '280px');
    const above = await popup.boundingBox(),
      anchor = await trigger.boundingBox();
    expect(above.x).toBeGreaterThanOrEqual(8);
    expect(above.x + above.width).toBeLessThanOrEqual(592);
    expect(above.y + above.height).toBeLessThanOrEqual(anchor.y);
    await page.locator('#root').evaluate(el => (el.style.top = '10px'));
    await page.setViewportSize({ width: 600, height: 701 });
    await expect.poll(async () => (await popup.boundingBox()).y).toBeGreaterThan(30);
    const below = await popup.boundingBox();
    expect(below.y).toBeGreaterThanOrEqual((await trigger.boundingBox()).y + (await trigger.boundingBox()).height);
  } finally {
    await page.close();
  }
});
