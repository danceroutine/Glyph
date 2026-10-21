import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { afterAll, beforeAll, it } from 'vitest';
import { coverageBuildOptions, newCoveredPage } from '#scripts/code-oss/tests/support/coverage.mjs';
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
    import { WiredGlyphModeSwapCard } from './code-oss/ui/GlyphModeSwapCard/GlyphModeSwapCard.wired.tsx';
    window.decisions = [];
    window.show = (swap, disabled = false) => render(h(WiredGlyphModeSwapCard, {swap, chatId:'chat', runId:'run', disabled,
      actions: {decideApproval: async (...args) => { window.decisions.push(args); if (window.fail) throw new Error('Disconnected'); }}
    }), document.getElementById('root'));
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
afterAll(async () => browser?.close());
async function mount() {
  const page = await newCoveredPage(browser);
  await page.clock.install({ time: new Date('2026-10-18T11:59:59Z') });
  await page.clock.pauseAt(new Date('2026-10-18T12:00:00Z'));
  await page.setContent('<div id="root" style="width:600px"></div>');
  await page.addScriptTag({ content: script });
  return page;
}
const swap = {
  id: 'swap',
  source: 'plan',
  target: 'agent',
  status: 'pending',
  description: 'Implement the reviewed plan.',
  autoApprove: false,
  startedAt: '2026-10-18T12:00:00Z',
  expiresAt: '2026-10-18T12:00:15Z',
};
it('counts down the host deadline across rerenders without issuing an automatic decision from the renderer', async () => {
  const page = await mount();
  try {
    await page.evaluate(swap => window.show(swap), swap);
    const bar = page.getByRole('progressbar', { name: 'Automatic denial countdown' });
    await expect(bar).toHaveAttribute('aria-valuenow', '100');
    await expect(bar).toHaveCSS('height', '5px');
    const full = await bar.locator('div').boundingBox();
    expect(full.width).toBeCloseTo(await page.getByRole('region').evaluate(element => element.clientWidth), 0);
    await page.clock.fastForward(5000);
    await page.evaluate(swap => window.show({ ...swap }), swap);
    await expect(bar).toHaveAttribute('aria-valuetext', '10 seconds remaining');
    const shrunk = await bar.locator('div').boundingBox();
    expect(shrunk.x).toBe(full.x);
    expect(shrunk.width / full.width).toBeCloseTo(2 / 3, 1);
    await page.evaluate(swap => window.show({ ...swap }), swap);
    expect((await bar.locator('div').boundingBox()).width).toBeCloseTo(shrunk.width, 0);
    await page.clock.fastForward(10000);
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.decisions)).toEqual([]);
    await page.evaluate(swap => window.show({ ...swap, status: 'denied' }), swap);
    await expect(page.getByRole('heading')).toHaveText('Switch to Agent Mode denied');
    await expect(page.getByRole('button')).toHaveCount(0);
  } finally {
    await page.close();
  }
});
it('submits approval once, retains the description, and displays the host-confirmed state', async () => {
  const page = await mount();
  try {
    await page.evaluate(swap => window.show(swap), swap);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.decisions)).toEqual([['chat', 'run', 'swap', 'allow_once']]);
    await page.evaluate(swap => window.show({ ...swap, status: 'approved' }), swap);
    await expect(page.getByRole('heading')).toHaveText('Switched to Agent Mode');
    await expect(page.getByText(swap.description)).toBeVisible();
    await expect(page.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('region')).toHaveAttribute('aria-busy', 'false');
  } finally {
    await page.close();
  }
});
it('allows retry after a failed decision and disables decisions in another window', async () => {
  const page = await mount();
  try {
    await page.evaluate(
      swap => {
        window.fail = true;
        window.show(swap);
      },
      { ...swap, autoApprove: true },
    );
    await expect(page.getByRole('progressbar', { name: 'Automatic approval countdown' })).toBeVisible();
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Disconnected');
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeEnabled();
    await page.evaluate(swap => window.show(swap, true), swap);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeDisabled();
  } finally {
    await page.close();
  }
});

it('uses the source mode color and preserves progress when mounting midway through a custom timeout', async () => {
  const page = await mount();
  try {
    await page.evaluate(
      () =>
        (document.getElementById('root').style.cssText +=
          '; --vscode-editorWarning-foreground: rgb(220, 180, 0); --vscode-descriptionForeground: rgb(150, 150, 150)'),
    );
    await page.clock.fastForward(10000);
    await page.evaluate(swap => window.show({ ...swap, expiresAt: '2026-10-18T12:00:20Z' }), swap);
    const bar = page.getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', '50');
    await expect(bar.locator('div')).toHaveCSS('background-color', 'rgb(220, 180, 0)');
    await page.evaluate(swap => window.show({ ...swap, source: 'agent', target: 'plan' }), swap);
    await expect(bar.locator('div')).toHaveCSS('background-color', 'rgb(150, 150, 150)');
    await page.evaluate(swap => window.show({ ...swap, status: 'approved' }), swap);
    await expect(bar).toHaveCount(0);
  } finally {
    await page.close();
  }
});
