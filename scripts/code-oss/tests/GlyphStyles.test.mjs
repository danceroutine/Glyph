import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { afterAll, beforeAll, it } from 'vitest';

const requireUpstream = createRequire(new URL('../../../.code-oss/src/package.json', import.meta.url));
const { chromium, expect } = requireUpstream('@playwright/test');
let browser;
let script;

beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { mountGlyphWorkbench } from './code-oss/ui/mountGlyphWorkbench.tsx';
        import { workbenchState, previewActions } from './code-oss/storybook/fixtures.ts';
        mountGlyphWorkbench(document.getElementById('root'), workbenchState(), previewActions);
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

it('uses live theme variables without styling controls outside Glyph', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<textarea id="outside"></textarea><div id="root" style="height:400px"></div>');
    const outside = page.locator('#outside');
    const originalBackground = await outside.evaluate(element => getComputedStyle(element).backgroundColor);
    await page.addScriptTag({ content: script });
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    for (const color of ['rgb(49, 49, 49)', 'rgb(255, 255, 255)']) {
      await page.locator('#root').evaluate((element, value) => {
        element.style.setProperty('--vscode-input-background', value);
      }, color);
      await expect(composer).toHaveCSS('background-color', color);
      await expect(outside).toHaveCSS('background-color', originalBackground);
    }
    await expect(page.locator('.glyph-workbench')).toHaveCSS('display', 'flex');
    await expect(page.locator('.glyph-transcript')).toHaveCSS('overflow-y', 'auto');
  } finally {
    await page.close();
  }
});

it('preserves production styles when style elements are cloned into another document', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="root" style="height:400px;--vscode-input-background:rgb(49,49,49)"></div>');
    await page.addScriptTag({ content: script });
    // Code OSS auxiliary windows clone style nodes. CSSOM insertRule calls do
    // not survive cloneNode, so exercise the production Emotion configuration.
    await page.evaluate(async () => {
      const frame = document.createElement('iframe');
      const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
      document.body.append(frame);
      await loaded;
      for (const style of document.head.querySelectorAll('style')) {
        frame.contentDocument.head.append(style.cloneNode(true));
      }
      frame.contentDocument.body.append(document.getElementById('root').cloneNode(true));
    });
    const clone = page.frameLocator('iframe');
    await expect(clone.locator('.glyph-workbench')).toHaveCSS('display', 'flex');
    await expect(clone.locator('.glyph-composer')).toHaveCSS('padding', '8px');
    await expect(clone.getByRole('textbox', { name: 'Message Glyph' })).toHaveCSS(
      'background-color',
      'rgb(49, 49, 49)',
    );
  } finally {
    await page.close();
  }
});

it('places history beside a wide conversation and uses a dismissible drawer in a narrow pane', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.setContent('<div id="root" style="width:900px;height:600px"></div>');
    await page.addScriptTag({ content: script });
    const toggle = page.getByRole('button', { name: 'Chat history', exact: true });
    await toggle.click();
    const history = page.getByRole('complementary', { name: 'Chat history' });
    await expect(history).toHaveCSS('position', 'static');
    const historyBox = await history.boundingBox();
    const accountBox = await page.locator('.glyph-account-picker').boundingBox();
    expect(Math.abs(accountBox.y + accountBox.height - historyBox.y - historyBox.height)).toBeLessThan(2);
    await page.locator('#root').evaluate(element => {
      element.style.width = '320px';
    });
    await expect(history).toHaveCSS('position', 'absolute');
    await page.getByRole('searchbox', { name: 'Search chats' }).focus();
    await page.keyboard.press('Escape');
    await expect(history).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await page.close();
  }
});
