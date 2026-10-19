import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../../ui/design-system/codeOssTheme.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { previewThemeStyles } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
async function expectPreviewPalette(page, theme) {
  const mismatches = await page.evaluate(preview => {
    const native = getComputedStyle(document.querySelector('.glyph-workbench'));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const rgba = color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    return Object.entries(preview).flatMap(([name, expected]) => {
      if (!CSS.supports('color', expected)) return [];
      const actual = native.getPropertyValue(name).trim();
      if (!actual) return [{ name, expected, actual }];
      const expectedRgba = rgba(expected);
      return rgba(actual).some((channel, i) => Math.abs(channel - expectedRgba[i]) > 1)
        ? [{ name, expected, actual }]
        : [];
    });
  }, previewThemeStyles(theme));
  expect(mismatches, 'Storybook colors must match the native theme').toEqual([]);
}
it('defaults to the preview theme and uses compact message spacing', async ({ glyph }, testInfo) => {
  await expectPreviewPalette(glyph.page, 'dark');
  await glyph.send('Compare user message styling.');
  await glyph.waitForResponse();
  await glyph.send('And compare a second turn.');
  await glyph.waitForResponse(1);
  const bubble = glyph.userEntries.first().locator(':scope > div').first();
  await expect(bubble).toHaveCSS('background-color', 'rgb(49, 49, 49)');
  await expect(bubble).toHaveCSS('color', 'rgb(204, 204, 204)');
  await expect(glyph.page.locator('.glyph-composer-surface')).toHaveCSS('background-color', 'rgb(49, 49, 49)');
  await expect(glyph.userEntries.first()).toHaveCSS('margin-bottom', '12px');
  await expect(glyph.assistantEntries.first()).toHaveCSS('margin-bottom', '12px');
  const styles = await glyph.page.evaluate(() => {
    const selectors = ['.monaco-workbench', '.glyph-workbench', '.glyph-entry.user > div', '.glyph-composer-surface'];
    return selectors.map(selector => {
      const element = document.querySelector(selector);
      const s = getComputedStyle(element);
      return {
        selector,
        background: s.backgroundColor,
        color: s.color,
        font: s.font,
        padding: s.padding,
        border: s.border,
        variables: Object.fromEntries(
          Array.from(s)
            .filter(k => k.startsWith('--vscode-') && !k.startsWith('--vscode-icon-'))
            .map(k => [k, s.getPropertyValue(k)]),
        ),
      };
    });
  });
  await writeFile(testInfo.outputPath('theme.json'), JSON.stringify(styles, null, 2));
  await glyph.page.screenshot({ path: testInfo.outputPath('conversation.png') });
});
it.describe('Explicit theme selection', () => {
  it.use({ userSettings: { 'workbench.colorTheme': 'Light Modern' } });
  it('preserves the user theme instead of resetting it to the Glyph default', async ({ glyph }) => {
    await expectPreviewPalette(glyph.page, 'light');
    await glyph.send('This theme was chosen explicitly.');
    await glyph.waitForResponse();
    await expect(glyph.userEntries.first().locator(':scope > div').first()).toHaveCSS(
      'background-color',
      'rgb(255, 255, 255)',
    );
    await expect(glyph.page.locator('.monaco-workbench')).toHaveClass(/\bvs\b/);
  });
});
