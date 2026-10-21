import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { beforeAll, afterAll, it } from 'vitest';
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
    import { render, h } from 'preact';
    import { WiredGlyphShellCommandCard } from './code-oss/ui/GlyphShellCommandCard/GlyphShellCommandCard.wired.tsx';
    const activity = { id: 'call', name: 'execute_shell', status: 'completed', shell: { command: 'read line', output: '<script>alert(1)</script>\\nready\\n', sessionId: 'session', background: true, live: true, running: true } };
    window.requests = [];
    const operation = (...args) => { window.requests.push(args); return new Promise((resolve, reject) => { window.fail = () => reject(new Error('Write failed.')); window.acknowledge = resolve; }); };
    let props = { activity, chatId: 'chat', readOnly: false, actions: { writeShellInput: operation, stopShell: operation } };
    window.update = patch => { props = { ...props, ...patch }; render(h(WiredGlyphShellCommandCard, props), document.getElementById('root')); };
    window.disconnect = () => window.update({ activity: { ...activity, shell: { ...activity.shell, live: false, running: false } } });
    window.update({});
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
async function mount() {
  const page = await newCoveredPage(browser);
  await page.setContent('<div id="root" style="width:280px"></div>');
  await page.addScriptTag({ content: script });
  return page;
}

it('keeps failed input editable, prevents duplicate writes, and preserves expansion through state updates', async () => {
  const page = await mount();
  try {
    const card = page.getByRole('region', { name: 'Shell command' });
    const toggle = card.getByRole('button').first();
    await toggle.click();
    await card.getByRole('textbox').fill('draft');
    await card.getByRole('form').evaluate(element => {
      element.requestSubmit();
      element.requestSubmit();
    });
    expect(await page.evaluate(() => window.requests)).toEqual([['chat', 'session', 'draft', true]]);
    await expect(card.getByRole('button', { name: 'Close shell' })).toBeDisabled();
    await page.evaluate(() => window.fail());
    await expect(card.getByRole('alert')).toHaveText('Write failed.');
    await expect(card.getByRole('textbox')).toHaveValue('draft');
    await card.getByRole('button', { name: 'Send input' }).click();
    await page.evaluate(() => window.acknowledge());
    await expect(card.getByRole('textbox')).toHaveValue('');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(card.getByLabel('Command output')).toContainText('<script>alert(1)</script>');
    await expect(card.locator('script')).toHaveCount(0);
  } finally {
    await page.close();
  }
});
it('disables writes and closes for read-only peers and removes live controls on disconnect', async () => {
  const page = await mount();
  try {
    const card = page.getByRole('region', { name: 'Shell command' });
    await card.getByRole('button').first().click();
    await page.evaluate(() => window.update({ readOnly: true }));
    await expect(card.getByRole('textbox')).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Send input' })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Close shell' })).toBeDisabled();
    await page.evaluate(() => window.disconnect());
    await expect(card.getByRole('form')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Close shell' })).toHaveCount(0);
    expect(await page.evaluate(() => window.requests)).toEqual([]);
  } finally {
    await page.close();
  }
});
