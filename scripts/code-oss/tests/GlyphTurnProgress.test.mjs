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
      import { h, render } from 'preact';
      import { GlyphTurnProgress } from './code-oss/ui/GlyphTurnProgress/GlyphTurnProgress.presentational.tsx';
      window.openedLinks = [];
      window.show = (tools, status = 'streaming') => render(h(GlyphTurnProgress, { progress: { reasoning: '', tools, status }, openLink: href => window.openedLinks.push(href) }), document.getElementById('root'));
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
const calls = [
  {
    id: 'read',
    name: 'read_project_file',
    status: 'completed',
    arguments: '{"path":"queue.ts"}',
    summary: 'Captured file contents.',
    textOffset: 0,
  },
  { id: 'search', name: 'search_project', status: 'started', arguments: '{"query":"queue"}', textOffset: 0 },
];
/** @param {import('@playwright/test').BrowserContextOptions} [options] */
async function mount(options) {
  const page = await newCoveredPage(browser, options);
  await page.setContent(
    '<div id="root" style="width:280px;--vscode-descriptionForeground:#888;--vscode-foreground:#ccc"></div><button id="outside">Outside</button>',
  );
  await page.addScriptTag({ content: script });
  return page;
}
it('bundles consecutive calls, reveals details, and preserves expanded rows across streaming updates', async () => {
  const page = await mount();
  try {
    await page.evaluate(value => window.show(value), calls);
    const group = page.locator('.glyph-tool-group > summary');
    await expect(group).toHaveText('Exploring2 tools');
    await expect(page.getByRole('list', { name: 'Tool activity' })).toBeHidden();
    await page.mouse.move(600, 400);
    await expect(group.locator('.glyph-tool-chevron')).toHaveCSS('opacity', '0');
    await group.hover();
    await expect(group.locator('.glyph-tool-chevron')).toHaveCSS('opacity', '1');
    await group.click();
    const first = page.locator('[data-tool-id="read"]');
    await first.locator('summary').click();
    await expect(first.locator('pre')).toHaveText('{\n  "path": "queue.ts"\n}\n\nCaptured file contents.');
    const running = page.locator('[data-tool-id="search"] summary');
    await expect(running).toHaveCSS('animation-name', 'glyph-tool-shimmer');
    await page.evaluate(
      value => window.show(value, 'completed'),
      calls.map(call => ({ ...call, status: 'completed' })),
    );
    await expect(group).toHaveText('Explored2 tools');
    await expect(first.locator('pre')).toBeVisible();
    await expect(running).toHaveCSS('animation-name', 'none');
    await group.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('list', { name: 'Tool activity' })).toBeHidden();
    await page.mouse.move(600, 400);
    await expect(group.locator('.glyph-tool-chevron')).toHaveCSS('opacity', '1');
  } finally {
    await page.close();
  }
});
it('sweeps once across the entire summary and resets only after the highlight leaves the text', async () => {
  const page = await mount();
  try {
    await page.evaluate(value => window.show(value), calls);
    const summary = page.locator('.glyph-tool-group > summary');
    await page.mouse.move(600, 400);
    const count = await summary.evaluate(
      element =>
        element.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'glyph-tool-shimmer')
          .length,
    );
    expect(count).toBe(1);
    await expect(summary.locator('span').first()).toHaveCSS('animation-name', 'none');
    const frame = async time => {
      await summary.evaluate((element, /** @type {number} */ elapsed) => {
        const animation = element
          .getAnimations()
          .find(animation => animation instanceof CSSAnimation && animation.animationName === 'glyph-tool-shimmer');
        if (animation === undefined) throw new Error('The shimmer animation is missing.');
        animation.pause();
        animation.currentTime = elapsed;
      }, time);
      return summary.screenshot();
    };
    const start = await frame(0);
    const left = await frame(450);
    const right = await frame(1350);
    const end = await frame(1799);
    expect(left.equals(start)).toBe(false);
    expect(right.equals(left)).toBe(false);
    expect(end.equals(start)).toBe(true);
  } finally {
    await page.close();
  }
});

it('separates batches across assistant text and stops shimmer on interruption or reduced motion', async () => {
  const page = await mount({ reducedMotion: 'reduce' });
  try {
    await page.evaluate(
      value => window.show([...value, ...value.map(call => ({ ...call, id: call.id + '-later', textOffset: 80 }))]),
      calls,
    );
    await expect(page.locator('.glyph-tool-group')).toHaveCount(2);
    await page.locator('.glyph-tool-group > summary').first().click();
    const row = page.locator('[data-tool-id="search"]');
    await expect(row).toHaveAttribute('aria-busy', 'true');
    await expect(row.locator('summary')).toHaveCSS('animation-name', 'none');
    await page.evaluate(value => window.show(value, 'interrupted'), calls);
    await expect(row).toHaveAttribute('aria-busy', 'false');
    await expect(row.locator('summary')).toHaveText('Interrupted · search project');
  } finally {
    await page.close();
  }
});
it('shows a single failed call directly and renders tool payloads as literal text', async () => {
  const page = await mount();
  try {
    await page.evaluate(() =>
      window.show(
        [
          {
            id: 'failed',
            name: 'read_project_file',
            status: 'failed',
            arguments: '{"path":"missing.ts"}',
            summary: '<img src=x onerror="window.injected=true"> File not found.',
          },
        ],
        'completed',
      ),
    );
    await expect(page.locator('.glyph-tool-group')).toHaveCount(0);
    await page.locator('[data-tool-id="failed"] summary').click();
    await expect(page.locator('pre')).toContainText('File not found.');
    await expect(page.locator('pre img')).toHaveCount(0);
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
  } finally {
    await page.close();
  }
});

const webSearch = {
  id: 'web',
  name: 'web_search',
  status: 'started',
  arguments: '{"query":"octopus"}',
  textOffset: 0,
};
const webResults = {
  kind: 'web_search',
  query: 'octopus',
  searchUrl: 'https://search.example/?q=octopus',
  provenance: 'search_snippets_only',
  results: [{ title: 'Octopus facts', url: 'https://source.example/octopus', snippet: 'Eight arms.' }],
};
it('shares the tool disclosure and shimmer, keeps results inline, and preserves expansion when a search completes', async () => {
  const page = await mount();
  try {
    await page.evaluate(tool => window.show([tool]), webSearch);
    const summary = page.locator('[data-tool-id="web"] summary');
    const details = page.locator('[data-tool-id="web"] details');
    await expect(summary).toHaveCSS('animation-name', 'glyph-tool-shimmer');
    await summary.hover();
    await expect(details).not.toHaveAttribute('open');
    await page.mouse.move(600, 400);
    await expect(details).not.toHaveAttribute('open');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Waiting for the result…')).toBeVisible();
    await page.evaluate(
      ({ tool, result }) =>
        window.show([{ ...tool, status: 'completed', summary: JSON.stringify(result) }], 'completed'),
      { tool: webSearch, result: webResults },
    );
    await expect(summary).toHaveText('Searched web octopus');
    await expect(summary).toHaveCSS('animation-name', 'none');
    const sources = page.getByRole('list', { name: 'Web search results', exact: true });
    await expect(sources).toBeVisible();
    expect((await sources.boundingBox()).y).toBeGreaterThan((await summary.boundingBox()).y);
    await page.getByRole('link', { name: 'Octopus facts', exact: true }).click();
    expect(await page.evaluate(() => window.openedLinks)).toEqual(['https://source.example/octopus']);
    await expect(sources).toBeVisible();
    await summary.focus();
    await page.keyboard.press('Space');
    await expect(sources).toBeHidden();
    await summary.hover();
    await expect(sources).toBeHidden();
    await expect(page.getByRole('listbox')).toHaveCount(0);
  } finally {
    await page.close();
  }
});

it('shows one empty-result message inside the toggle and keeps errors and cancellation inside it too', async () => {
  const page = await mount();
  try {
    for (const [status, result, message] of [
      ['completed', { ...webResults, results: [] }, 'No results found'],
      [
        'completed',
        { kind: 'web_error', error: { code: 'HTTP_ERROR', message: 'The website returned HTTP 503.' } },
        'The website returned HTTP 503.',
      ],
      ['interrupted', undefined, 'Request cancelled'],
    ]) {
      await page.evaluate(
        ({ tool, status: toolStatus, result: toolResult }) =>
          window.show([{ ...tool, status: toolStatus, summary: JSON.stringify(toolResult) }], 'completed'),
        { tool: webSearch, status, result },
      );
      const summary = page.locator('[data-tool-id="web"] summary');
      const bodyMessage = page.getByText(message, { exact: true });
      await expect(bodyMessage).toHaveCount(1);
      await expect(bodyMessage).toBeHidden();
      await summary.click();
      await expect(bodyMessage).toBeVisible();
      await summary.click();
      await expect(bodyMessage).toBeHidden();
    }
  } finally {
    await page.close();
  }
});
