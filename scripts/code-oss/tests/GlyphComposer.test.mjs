import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, it } from 'vitest';

const requireUpstream = createRequire(new URL('../../../.code-oss/src/package.json', import.meta.url));
const { chromium, expect } = requireUpstream('@playwright/test');
let browser;
let script;

beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { h, render } from 'preact';
        import { GlyphComposer } from './code-oss/ui/GlyphComposer.tsx';
        import { GlyphComposerState } from './src/desktop/workbench/GlyphComposerState.ts';
        const calls = [];
        const pending = [];
        const actions = {
          composer: new GlyphComposerState(),
          send(text) { calls.push(text); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
          cancel() {}
        };
        window.composerTest = {
          calls,
          unmount() { render(null, document.getElementById('root')); },
          mount() { render(h(GlyphComposer, { status: 'ready', selection: undefined, actions }), document.getElementById('root')); },
          reject() { pending.shift().reject(new Error('Connection unavailable')); },
          resolve() { pending.shift().resolve(); }
        };
        render(h(GlyphComposer, { status: 'ready', selection: undefined, actions }), document.getElementById('root'));
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe('GlyphComposer draft recovery', () => {
  it.each(['before', 'after'])(
    'retains the draft and recovered message when send fails %s pane disposal',
    async when => {
      const page = await browser.newPage();
      try {
        await page.setContent('<div id="root"></div>');
        await page.addScriptTag({ content: script });
        const composer = page.getByRole('textbox', { name: 'Message Glyph' });
        await composer.fill('Original message');
        await page.getByRole('button', { name: 'Send (⌘/Ctrl+Enter)', exact: true }).click();
        await composer.fill('Newer draft');
        if (when === 'before') await page.evaluate(() => window.composerTest.reject());
        await page.evaluate(() => window.composerTest.unmount());
        if (when === 'after') await page.evaluate(() => window.composerTest.reject());
        await page.evaluate(() => window.composerTest.mount());
        await expect(composer).toHaveValue('Newer draft', { timeout: 500 });
        await expect(page.getByRole('region', { name: 'Unsent messages' })).toContainText('Original message');
      } finally {
        await page.close();
      }
    },
  );
  it('retains a failed message separately from a newer draft and lets the user edit either without losing the other', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      const send = page.getByRole('button', { name: 'Send (⌘/Ctrl+Enter)', exact: true });
      await composer.fill('Original unsent message');
      await send.click();
      await expect(composer).toHaveValue('');
      await composer.fill('Newer draft');
      await page.evaluate(() => window.composerTest.reject());
      await expect(page.getByRole('alert')).toContainText('Connection unavailable');
      await expect(composer).toHaveValue('Newer draft');
      const unsent = page.getByRole('region', { name: 'Unsent messages' });
      await expect(unsent).toContainText('Original unsent message', { timeout: 1_000 });
      await unsent.getByRole('button', { name: 'Edit unsent message' }).click();
      await expect(composer).toHaveValue('Original unsent message');
      await expect(unsent).toContainText('Newer draft');
      await send.click();
      await page.evaluate(() => window.composerTest.resolve());
      await expect(unsent).toContainText('Newer draft');
      expect(await page.evaluate(() => window.composerTest.calls)).toEqual([
        'Original unsent message',
        'Original unsent message',
      ]);
    } finally {
      await page.close();
    }
  });

  it('restores a rejected message directly when no newer draft was typed', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      await composer.fill('Keep this message');
      await page.getByRole('button', { name: 'Send (⌘/Ctrl+Enter)', exact: true }).click();
      await page.evaluate(() => window.composerTest.reject());
      await expect(composer).toHaveValue('Keep this message');
    } finally {
      await page.close();
    }
  });

  it('preserves every rejected message through successive failures without sending a newer draft implicitly', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      const send = page.getByRole('button', { name: 'Send (⌘/Ctrl+Enter)', exact: true });
      await composer.fill('First message');
      await send.click();
      await composer.fill('Second message');
      await page.evaluate(() => window.composerTest.reject());
      const unsent = page.getByRole('region', { name: 'Unsent messages' });
      await expect(unsent).toContainText('First message');
      await send.click();
      await composer.fill('Third draft');
      await page.evaluate(() => window.composerTest.reject());
      await expect(unsent).toContainText('Second message');
      await expect(unsent).toContainText('First message');
      await expect(composer).toHaveValue('Third draft');
      expect(await page.evaluate(() => window.composerTest.calls)).toEqual(['First message', 'Second message']);
    } finally {
      await page.close();
    }
  });
});
