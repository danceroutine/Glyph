import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { afterAll, beforeAll, it } from 'vitest';
const { chromium, expect } = createRequire(new URL('../../../.code-oss/src/package.json', import.meta.url))(
  '@playwright/test',
);
let browser, script;
beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import { h, render } from 'preact';
      import { WiredGlyphMarkdown } from './code-oss/ui/GlyphMarkdown/GlyphMarkdown.wired.tsx';
      import { WiredGlyphTranscript } from './code-oss/ui/GlyphTranscript/GlyphTranscript.wired.tsx';
      import { previewThemeStyles } from './code-oss/ui/design-system/index.ts';
      window.copies = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => {
        if (window.failCopy) throw new Error('Clipboard unavailable');
        window.copies.push(value);
      } } });
      const fence = String.fromCharCode(96).repeat(3);
      const markdown = blocks => blocks.map(({source, language = ''}) => fence + language + '\\n' + source + '\\n' + fence).join('\\n\\n');
      window.show = (blocks, theme = 'dark') => render(h('div', { 'data-theme': theme, style: { ...previewThemeStyles(theme), width: '300px' } },
        h(WiredGlyphMarkdown, { text: markdown(blocks), openLink: () => {} })), document.getElementById('root'));
      window.showAttachment = () => render(h(WiredGlyphTranscript, { entries: [{id: 'code', role: 'user', text: markdown([{source: 'const file = "@src/file.ts";', language: 'ts'}]), attachments: [{path:'src/file.ts', text:'captured', revision:'1'}]}], chatId: 'chat', actions: {} }), document.getElementById('root'));
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
}, 30000);
afterAll(async () => browser?.close());
async function mount() {
  const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: script });
  return page;
}
const source = 'const next = queue.shift();\nif (next) await send("' + 'a long message '.repeat(20) + '");';
it('highlights syntax, wraps per block without pane overflow, and copies exact code', async () => {
  const page = await mount();
  try {
    await page.evaluate(
      source =>
        window.show([
          { source, language: 'ts' },
          { source: 'print("hello")', language: 'python' },
        ]),
      source,
    );
    const blocks = page.locator('.glyph-code-block');
    const first = blocks.first();
    await expect(first.locator('.hljs-keyword').first()).toHaveText('const');
    const keywordColor = await first
      .locator('.hljs-keyword')
      .first()
      .evaluate(el => getComputedStyle(el).color);
    const stringColor = await first
      .locator('.hljs-string')
      .first()
      .evaluate(el => getComputedStyle(el).color);
    expect(keywordColor).not.toBe(stringColor);
    await expect(first.locator('pre')).toHaveCSS('white-space', 'pre');
    expect(await first.locator('pre').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    const wrap = first.getByRole('button', { name: 'Wrap code' });
    await wrap.click();
    await expect(wrap).toHaveAttribute('aria-pressed', 'true');
    await expect(first.locator('pre')).toHaveCSS('white-space', 'pre-wrap');
    expect(await first.locator('pre').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: '.artifacts/chat-code-blocks-dark.png' });
    await expect(blocks.last().getByRole('button', { name: 'Wrap code' })).toHaveAttribute('aria-pressed', 'false');
    await first.getByRole('button', { name: 'Copy code', exact: true }).click();
    await expect(first.getByRole('button', { name: 'Copied code', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.copies)).toEqual([source]);
    await wrap.focus();
    await wrap.press('Space');
    await expect(wrap).toHaveAttribute('aria-pressed', 'false');
    for (const button of await first.getByRole('button').all()) {
      const bounds = await button.boundingBox();
      expect(bounds.width).toBe(bounds.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await page.close();
  }
});
it('keeps HTML inert and unknown, unlabelled, and empty fences readable', async () => {
  const page = await mount();
  try {
    const sources = [
      '<img src=x onerror="window.injected=true">',
      '<script>alert("hello")</script>',
      'unlabelled <literal> & text',
      '',
    ];
    await page.evaluate(
      sources =>
        window.show(sources.map((source, index) => ({ source, language: ['html', 'unknown', '', 'text'][index] }))),
      sources,
    );
    const blocks = page.locator('.glyph-code-block');
    await expect(blocks).toHaveCount(4);
    for (let i = 0; i < sources.length; i++) expect(await blocks.nth(i).locator('code').textContent()).toBe(sources[i]);
    await expect(page.locator('.glyph-code-block img, .glyph-code-block script')).toHaveCount(0);
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    await expect(blocks.nth(1).locator('code span')).toHaveCount(0);
    await blocks.last().getByRole('button', { name: 'Copy code', exact: true }).click();
    expect(await page.evaluate(() => window.copies)).toEqual(['']);
  } finally {
    await page.close();
  }
});
it('preserves wrap across streaming updates, resets copy feedback, and recovers from clipboard failure', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => window.show([{ source: 'const next =', language: 'ts' }]));
    await page.getByRole('button', { name: 'Wrap code' }).click();
    await page.getByRole('button', { name: 'Copy code', exact: true }).click();
    await page.evaluate(() => window.show([{ source: 'const next = queue.shift();', language: 'ts' }]));
    await expect(page.getByRole('button', { name: 'Wrap code' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Copy code', exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.failCopy = true;
    });
    await page.getByRole('button', { name: 'Copy code', exact: true }).click();
    const retry = page.getByRole('button', { name: 'Copy failed. Try again', exact: true });
    await expect(retry).toBeVisible();
    await page.evaluate(() => {
      window.failCopy = false;
    });
    await retry.click();
    expect(await page.evaluate(() => window.copies.at(-1))).toBe('const next = queue.shift();');
    await expect(page.getByRole('button', { name: 'Copied code', exact: true })).toBeVisible();
  } finally {
    await page.close();
  }
});
it('uses light and dark syntax colors and keeps attachment mentions intact in fenced code', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => window.show([{ source: 'const value = 1;', language: 'ts' }]));
    const keyword = page.locator('.hljs-keyword');
    const dark = await keyword.evaluate(el => getComputedStyle(el).color);
    await page.evaluate(() => window.show([{ source: 'const value = 1;', language: 'ts' }], 'light'));
    expect(await keyword.evaluate(el => getComputedStyle(el).color)).not.toBe(dark);
    await page.evaluate(() => window.showAttachment());
    expect(await page.locator('.glyph-code-block code').textContent()).toBe('const file = "@src/file.ts";');
    await page.getByRole('button', { name: 'Copy code', exact: true }).click();
    expect(await page.evaluate(() => window.copies.at(-1))).toBe('const file = "@src/file.ts";');
    // Controls do not add text to the annotated source's offsets.
    expect(await page.locator('[data-glyph-source="code"]').textContent()).toBe('const file = "@src/file.ts";');
  } finally {
    await page.close();
  }
});
