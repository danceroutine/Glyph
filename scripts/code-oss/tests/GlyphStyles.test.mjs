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
        import { mountGlyphWorkbench } from './code-oss/ui/mountGlyphWorkbench.tsx';
        import { workbenchStateFixture } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
        import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';
        import { stageClassName } from './code-oss/storybook/previewStyles.ts';
        window.glyphPreviewStage = stageClassName;
        window.newChat = () => window.glyphView.update(workbenchStateFixture({ models: [{ slug: 'test', name: 'Test model' }], selectedModel: 'test' }));
        const root = document.getElementById('root');
        window.glyphView = mountGlyphWorkbench(root, workbenchStateFixture(), previewActionsFixture({
          reserveHistoryWidth: width => {
            const before = root.clientWidth;
            root.style.width = (before + width) + 'px';
            return () => { root.style.width = (root.clientWidth - width) + 'px'; };
          },
        }));
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    ...coverageBuildOptions,
    // The IIFE harness supplies the module URL that the production ESM build provides.
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.url': '"https://glyph.test/ui/mountGlyphWorkbench.js"',
    },
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

it('uses live theme variables without styling controls outside Glyph', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<textarea id="outside"></textarea><div id="root" style="height:400px"></div>');
    const outside = page.locator('#outside');
    const originalBackground = await outside.evaluate(element => getComputedStyle(element).backgroundColor);
    await page.addScriptTag({ content: script });
    const composer = page.locator('.glyph-composer-surface');
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
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root" style="height:400px;--vscode-input-background:rgb(49,49,49)"></div>');
    await page.addScriptTag({ content: script });
    // Code OSS auxiliary windows clone style nodes. CSSOM insertRule calls do
    // not survive cloneNode, so exercise the production Emotion configuration.
    await page.evaluate(async () => {
      const frame = document.createElement('iframe');
      const loaded = new Promise(resolve => {
        frame.addEventListener('load', resolve, { once: true });
      });
      document.body.append(frame);
      await loaded;
      for (const style of document.head.querySelectorAll('style')) {
        frame.contentDocument.head.append(style.cloneNode(true));
      }
      frame.contentDocument.body.append(document.querySelector('#root').cloneNode(true));
    });
    const clone = page.frameLocator('iframe');
    await expect(clone.locator('.glyph-workbench')).toHaveCSS('display', 'flex');
    await expect(clone.locator('.glyph-composer')).toHaveCSS('padding', '8px');
    await expect(clone.locator('.glyph-composer-surface')).toHaveCSS('background-color', 'rgb(49, 49, 49)');
  } finally {
    await page.close();
  }
});

it('themes the real controls in Storybook and honors native overrides and optional border fallbacks', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root" style="height:600px;width:900px"></div>');
    await page.addScriptTag({ content: script });
    await page.locator('#root').evaluate(element => {
      if (!(element instanceof HTMLElement)) throw new TypeError('Expected the story root.');
      element.className = window.glyphPreviewStage;
    });
    await page.getByRole('button', { name: 'Chat history', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    const search = page.getByRole('searchbox', { name: 'Search chats' });
    await page.evaluate(() => window.newChat());
    const model = page.getByRole('combobox', { name: 'Model', exact: true });
    await model.click();
    const modelMenu = page.getByRole('listbox', { name: 'Models', exact: true });
    const modelPanel = modelMenu.locator('..');
    for (const [theme, background, foreground] of [
      ['dark', 'rgb(49, 49, 49)', 'rgb(204, 204, 204)'],
      ['light', 'rgb(255, 255, 255)', 'rgb(59, 59, 59)'],
    ]) {
      await page.locator('#root').evaluate((element, value) => {
        element.dataset.theme = value;
      }, theme);
      for (const control of [page.locator('.glyph-composer-surface'), search, modelPanel]) {
        await expect(control).toHaveCSS('background-color', background);
        await expect(control).toHaveCSS('color', foreground);
      }
    }
    // No remount or style regeneration: a host theme can supply independent
    // dropdown colors and omit optional input/dropdown borders.
    await page.locator('#root').evaluate(element => {
      element.style.setProperty('--vscode-dropdown-foreground', 'rgb(12, 34, 56)');
      element.style.setProperty('--vscode-panel-border', 'rgb(78, 90, 12)');
      element.style.setProperty('--vscode-input-border', 'initial');
      element.style.setProperty('--vscode-dropdown-border', 'initial');
    });
    await expect(modelMenu).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(model).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(composer).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(search).toHaveCSS('border-top-color', 'rgb(78, 90, 12)');
  } finally {
    await page.close();
  }
});

it('expands the host for side-by-side history and releases its width on close or unmount', async () => {
  const page = await newCoveredPage(browser, { viewport: { width: 1400, height: 800 } });
  try {
    await page.setContent('<div id="root" style="width:900px;height:600px"></div>');
    await page.addScriptTag({ content: script });
    const toggle = page.getByRole('button', { name: 'Chat history', exact: true });
    const history = page.getByRole('complementary', { name: 'Chat history' });
    const conversation = page.getByRole('main', { name: 'Current conversation' });
    for (const width of [900, 320]) {
      await page.locator('#root').evaluate((element, targetWidth) => {
        element.style.width = targetWidth + 'px';
      }, width);
      const before = await conversation.boundingBox();
      await toggle.click();
      await expect(history).toHaveCSS('position', 'static');
      await expect(page.locator('#root')).toHaveCSS('width', width + 260 + 'px');
      const historyBox = await history.boundingBox();
      const chatBox = await conversation.boundingBox();
      expect(Math.abs(chatBox.width - before.width)).toBeLessThan(2);
      expect(Math.abs(chatBox.x + chatBox.width - historyBox.x)).toBeLessThan(2);
      expect(await conversation.evaluate(element => element instanceof HTMLElement && element.inert)).toBe(false);
      const accountBox = await page.locator('.glyph-account-picker').boundingBox();
      expect(Math.abs(accountBox.y + accountBox.height - historyBox.y - historyBox.height)).toBeLessThan(2);
      await page.getByRole('searchbox', { name: 'Search chats' }).focus();
      await page.keyboard.press('Escape');
      await expect(history).toHaveCount(0);
      await expect(toggle).toBeFocused();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#root')).toHaveCSS('width', width + 'px');
    }
    await toggle.click();
    await page.locator('#root').evaluate(element => {
      element.style.width = '650px';
    });
    await toggle.click();
    await expect(page.locator('#root')).toHaveCSS('width', '390px');
    await toggle.click();
    await page.evaluate(() => {
      window.glyphView.dispose();
    });
    await expect(page.locator('#root')).toHaveCSS('width', '390px');
  } finally {
    await page.close();
  }
});
