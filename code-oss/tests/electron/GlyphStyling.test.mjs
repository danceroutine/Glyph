import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

it('keeps Glyph styled through native theme changes and a window reload', async ({ glyph }) => {
  await expect(glyph.page.locator('.glyph-workbench')).toHaveCSS('display', 'flex');
  await expect(glyph.page.locator('.glyph-composer')).toHaveCSS('padding', '8px');
  await expect(glyph.composer).toHaveCSS('min-height', '48px');

  const surface = glyph.page.locator('.glyph-composer-surface');
  const backgrounds = [];
  for (const theme of ['Dark Modern', 'Light Modern']) {
    await glyph.command('Preferences: Color Theme');
    const input = glyph.page.locator('.quick-input-widget input');
    await expect(input).toBeVisible();
    await input.fill(theme);
    await glyph.page.locator('.quick-input-list .monaco-list-row').filter({ hasText: theme }).first().click();
    await expect(input).not.toBeVisible();
    await expect(glyph.page.locator('.monaco-workbench')).toHaveClass(
      theme === 'Dark Modern' ? /\bvs-dark\b/ : /\bvs\b/,
    );
    backgrounds.push(await surface.evaluate(element => getComputedStyle(element).backgroundColor));
  }
  expect(backgrounds[0]).not.toBe(backgrounds[1]);
  expect(backgrounds).not.toContain('rgba(0, 0, 0, 0)');

  await glyph.reload();
  await expect(glyph.page.locator('.glyph-workbench')).toHaveCSS('display', 'flex');
  await expect(surface).toHaveCSS('background-color', backgrounds[1]);
  await glyph.send('Check the styled composer after reload.');
  await glyph.waitForResponse();
});
