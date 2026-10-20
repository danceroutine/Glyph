import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { buildGlyphDiagram } from '#scripts/code-oss/build-diagram.mjs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { coverageBuildOptions, newCoveredPage } from '#scripts/code-oss/tests/support/coverage.mjs';
import { chromium, expect } from '#scripts/code-oss/tests/support/playwright.mjs';
/** @type {import('@playwright/test').Browser} */
let browser;
/** @type {string} */
let renderer;
/** @type {string} */
let script;
/** @param {import('@playwright/test').Page} page */
async function mount(page) {
  await page.route('http://localhost/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: route.request().url().endsWith('glyph-diagram.html') ? renderer : '<div id="root"></div>',
    }),
  );
  await page.goto('http://localhost/');
  await page.addScriptTag({ content: script });
}
beforeAll(async () => {
  await buildGlyphDiagram('.artifacts/test-diagram');
  renderer = await readFile('.artifacts/test-diagram/glyph-diagram.html', 'utf8');
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { h, render } from 'preact';
    import { MessageActions } from './code-oss/ui/GlyphTranscript/GlyphTranscript.stories.tsx';
    import { WiredGlyphTranscript } from './code-oss/ui/GlyphTranscript/GlyphTranscript.wired.tsx';
    import { WiredGlyphUsageSummary } from './code-oss/ui/GlyphUsageSummary/GlyphUsageSummary.wired.tsx';
    import { WiredGlyphMarkdown } from './code-oss/ui/GlyphMarkdown/GlyphMarkdown.wired.tsx';
    import { createGlyphDiagramElement } from './code-oss/ui/GlyphDiagram/GlyphDiagramTree.ts';
    window.showMarkdown = text => {
      window.actions = [];
      render(h(WiredGlyphMarkdown, { text, openLink: href => window.actions.push(['link', href]) }), document.getElementById('root'));
    };
    window.buildDiagram = tree => createGlyphDiagramElement(document, tree).outerHTML;
    const usage = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 30, reasoningTokens: 12, totalTokens: 130 };
    window.showMessageActions = () => render(h(MessageActions.render, {}), document.getElementById('root'));
    window.actions = [];
    window.showMarkdown = text => render(h(WiredGlyphMarkdown, { text, openLink: href => window.actions.push(['link', href]) }), document.getElementById('root'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.actions.push(['copy', text]) } });
    const text = '## Result\\n\\n**Strong** and *emphasized*, with [source](src/a.ts).\\n\\n3. Three\\n4. Four\\n\\n> A quotation\\n\\n| Column | Value |\\n| --- | --- |\\n| Test | Passed |\\n\\n\`\`\`mermaid\\nflowchart LR\\n  A[Start] --> B[Done]\\n\`\`\`';
    const entries = [{ id: 'reply', checkpointTurnId: 'turn', role: 'assistant', text, usage, createdAt: '2026-10-17T15:30:00Z' },
      { id: 'context', checkpointTurnId: 'turn', role: 'user', text: '**Compare @a.ts and \`@b.ts\` here**', attachments: [{ path: 'a.ts', text: 'exact', revision: '1' }, { path: 'b.ts', text: 'exact b', revision: '2' }] }];
    const actions = { branchChat: async (chat, turn) => window.actions.push(['branch', chat, turn]), restoreCheckpoint: async (chat, turn) => window.actions.push(['restore', chat, turn]), openLink: async path => window.actions.push(['link', path]), context: { openAttachment: async attachment => window.actions.push(['attachment', attachment.path]) } };
    render(h('div', {}, [h(WiredGlyphTranscript, { entries, actions, chatId: 'chat' }), h(WiredGlyphUsageSummary, { usage })]), document.getElementById('root'));
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
afterAll(async () => {
  await browser?.close();
});

describe('Markdown messages and usage controls', () => {
  it('handles Escape as soon as an expanded diagram commits', async () => {
    const page = await newCoveredPage(browser);
    try {
      await mount(page);
      const expand = page.getByRole('button', { name: 'Expand diagram' });
      await expect(page.getByRole('img', { name: 'Plan diagram' })).toBeVisible();
      await page.evaluate(async () => {
        const button = document.querySelector('[aria-label="Expand diagram"]');
        if (!(button instanceof HTMLElement)) throw new TypeError('Expected the expand button.');
        button.click();
        await new Promise(queueMicrotask);
        if (!document.querySelector('[aria-label="Collapse diagram"]')) throw new Error('Expansion did not commit.');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      await expect(expand).toBeFocused();
    } finally {
      await page.close();
    }
  }, 15000);

  it('decodes entities once in prose and explicit links while preserving code, escapes, and autolinks', async () => {
    const page = await newCoveredPage(browser);
    try {
      await mount(page);
      await page.evaluate(() =>
        window.showMarkdown(
          [
            'Plain &amp; &lt;tag&gt; &copy; &#169; &#x1F9EA; &madeup;',
            'Once &amp;lt;tag&amp;gt; &#38;lt;tag&#38;gt;',
            'Escape \\&amp;',
            '`&amp; &#38;`',
            '```\n&amp; &#38;\n```',
            '&lt;img src=x onerror=alert(1)&gt;',
            '[Filtered results](https://example.test/search?first=1&amp;second=2)',
            '[One pass](https://example.test/search?first=1&#38;amp;second=2)',
            '<https://example.test/search?first=1&amp;second=2>',
          ].join('\n\n'),
        ),
      );
      await expect(page.locator('p').nth(0)).toHaveText('Plain & <tag> © © 🧪 &madeup;');
      await expect(page.locator('p').nth(1)).toHaveText('Once &lt;tag&gt; &lt;tag&gt;');
      await expect(page.locator('p').nth(2)).toHaveText('Escape &amp;');
      await expect(page.locator('p code')).toHaveText('&amp; &#38;');
      await expect(page.locator('pre')).toContainText('&amp; &#38;');
      await expect(page.locator('p').filter({ hasText: '<img src=x onerror=alert(1)>' })).toHaveCount(1);
      await expect(page.locator('#root img, #root script')).toHaveCount(0);
      await page.getByRole('link', { name: 'Filtered results', exact: true }).click();
      await page.getByRole('link', { name: 'One pass', exact: true }).click();
      await page.getByRole('link', { name: 'https://example.test/search?first=1&amp;second=2', exact: true }).click();
      expect(await page.evaluate(() => window.actions)).toEqual([
        ['link', 'https://example.test/search?first=1&second=2'],
        ['link', 'https://example.test/search?first=1&amp;second=2'],
        ['link', 'https://example.test/search?first=1&amp;second=2'],
      ]);
    } finally {
      await page.close();
    }
  }, 15000);

  it('preserves completed and outstanding task states in tight and loose Markdown lists', async () => {
    const page = await newCoveredPage(browser);
    try {
      await mount(page);
      await page.evaluate(() =>
        window.showMarkdown('- [x] Verified\n- [ ] Pending\n\n1. [x] Shipped\n\n2. [ ] Planned'),
      );
      const tasks = page.getByRole('checkbox');
      await expect(tasks).toHaveCount(4);
      for (const [index, checked] of [true, false, true, false].entries()) {
        await expect(tasks.nth(index)).toBeDisabled();
        await expect(tasks.nth(index)).toBeChecked({ checked });
      }
      await expect(page.locator('li')).toHaveText(['Verified', 'Pending', 'Shipped', 'Planned']);
    } finally {
      await page.close();
    }
  }, 15000);

  it('renders Markdown and Mermaid while preserving inline context and real message actions', async () => {
    const page = await newCoveredPage(browser);
    try {
      await mount(page);
      await expect(page.getByRole('heading', { name: 'Result' })).toBeVisible();
      await expect(page.locator('ol')).toHaveAttribute('start', '3');
      await expect(page.locator('blockquote')).toHaveText('A quotation');
      await expect(page.getByRole('table')).toContainText('Passed');
      await expect(page.getByRole('img', { name: 'Plan diagram' })).toBeVisible();
      const expand = page.getByRole('button', { name: 'Expand diagram' });
      const bounds = await expand.boundingBox();
      expect(bounds.width).toBe(bounds.height);
      await expand.click();
      await expect(page.getByRole('button', { name: 'Collapse diagram' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(expand).toBeFocused();
      await expect(page.locator('[data-glyph-source="context"] strong button')).toHaveText(['a.ts', 'b.ts']);
      await expect(page.locator('[data-glyph-source="context"] code button')).toHaveText('b.ts');
      await page.getByRole('button', { name: 'Open a.ts' }).click();
      await page.getByRole('link', { name: 'source' }).click();
      await page.getByRole('button', { name: 'Copy message' }).first().click();
      expect(await page.evaluate(() => window.actions.slice(0, 2))).toEqual([
        ['attachment', 'a.ts'],
        ['link', 'src/a.ts'],
      ]);
      expect((await page.evaluate(() => window.actions[2]))[1]).toContain('**Strong**');
      await page.getByRole('button', { name: 'Branch chat' }).click();
      await page.locator('.glyph-entry.user').hover();
      await page.getByRole('button', { name: 'Restore checkpoint' }).click();
      expect(await page.evaluate(() => window.actions.slice(3))).toEqual([
        ['branch', 'chat', 'turn'],
        ['restore', 'chat', 'turn'],
      ]);
      await expect(page.locator('.glyph-entry.user > strong')).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 15000);
  it('shows only icons for turn usage, reveals dates on hover, and dismisses popovers with Escape and outside clicks', async () => {
    const page = await newCoveredPage(browser, { viewport: { width: 360, height: 1000 } });
    try {
      await mount(page);
      const turn = page.getByRole('button', { name: 'Turn token usage' });
      await expect(turn).toHaveText('');
      const date = page.locator('time');
      await expect(date).toHaveCSS('opacity', '0');
      await page.locator('.glyph-entry.assistant').hover();
      await expect(date).toHaveCSS('opacity', '1');
      await turn.click();
      await expect(page.getByRole('dialog').locator('dd')).toHaveText(['100', '40', '30', '12', '130']);
      const bounds = await page.getByRole('dialog').boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(turn).toBeFocused();
      const conversation = page.getByRole('button', { name: 'Conversation token usage' });
      await expect(conversation).toHaveText('Usage');
      await conversation.click();
      await page.getByRole('heading', { name: 'Result' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 15000);
});

describe('Mermaid diagrams', () => {
  it('renders each diagram in a message independently', async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      const diagram = 'flowchart LR\n  A[Plan] --> B[Build]';
      await page.evaluate(
        text => window.showMarkdown(text),
        `\`\`\`mermaid\n${diagram}\n\`\`\`\n\n\`\`\`mermaid\n${diagram}\n\`\`\``,
      );
      const diagrams = page.getByRole('img', { name: 'Plan diagram' });
      await expect(diagrams).toHaveCount(2);
      for (const each of await diagrams.all()) {
        await expect(each.locator('svg')).toBeVisible();
        await expect(each.getByText('Build')).toBeVisible();
      }
    } finally {
      await page.close();
    }
  }, 15000);

  it('opens links attached to diagram nodes from a click or the keyboard', async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      const diagram = [
        'flowchart LR',
        '  A[Docs] --> B[Source]',
        '  B --> C[Script]',
        '  click A "https://example.com/docs"',
        '  click B href "src/a.ts"',
        '  click C "javascript:alert(1)"',
      ].join('\n');
      await page.evaluate(text => window.showMarkdown(text), `\`\`\`mermaid\n${diagram}\n\`\`\``);
      const figure = page.getByRole('figure', { name: 'Plan diagram' });
      await expect(figure.getByRole('link')).toHaveCount(2);
      await expect(figure.getByText('click')).toHaveCount(0);
      await figure.getByRole('link', { name: 'Docs' }).click();
      await figure.getByRole('link', { name: 'Source' }).focus();
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => window.actions)).toEqual([
        ['link', 'https://example.com/docs'],
        ['link', 'src/a.ts'],
      ]);
    } finally {
      await page.close();
    }
  }, 15000);

  it('renders sequence and gantt diagrams', async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      const sequence = 'sequenceDiagram\n  Composer->>Agent: Send';
      const gantt = 'gantt\n  dateFormat YYYY-MM-DD\n  section Build\n  Implement :a1, 2026-10-01, 3d';
      await page.evaluate(
        text => window.showMarkdown(text),
        `\`\`\`mermaid\n${sequence}\n\`\`\`\n\n\`\`\`mermaid\n${gantt}\n\`\`\``,
      );
      const diagrams = page.getByRole('img', { name: 'Plan diagram' });
      await expect(diagrams).toHaveCount(2);
      await expect(diagrams.first().getByText('Composer').first()).toBeVisible();
      await expect(diagrams.last().getByText('Implement')).toBeVisible();
    } finally {
      await page.close();
    }
  }, 15000);

  it('shows hostile diagram labels without adding executable markup to the page', async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      const flowchart =
        'flowchart LR\n  A["<img src=x onerror=window.pwned=1>"] --> B["<script>window.pwned=1</script>"]';
      const gantt =
        'gantt\n  title <img src=x onerror=window.pwned=1>\n  dateFormat YYYY-MM-DD\n  section Build\n  Implement :a1, 2026-10-01, 1d';
      await page.evaluate(
        text => window.showMarkdown(text),
        `\`\`\`mermaid\n${flowchart}\n\`\`\`\n\n\`\`\`mermaid\n${gantt}\n\`\`\``,
      );
      await expect(page.getByRole('img', { name: 'Plan diagram' })).toHaveCount(2);
      const unsafe = await page.evaluate(
        () =>
          [...document.querySelectorAll('[aria-label="Plan diagram"]')]
            .flatMap(host => [...host.shadowRoot.querySelectorAll('*')])
            .filter(
              element =>
                ['script', 'img', 'iframe', 'foreignObject', 'a'].includes(element.localName) ||
                [...element.attributes].some(attribute => /^on|href$/i.test(attribute.name)),
            ).length,
      );
      expect(unsafe).toBe(0);
      expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 15000);

  it('drops executable markup and remote references from renderer output', async () => {
    const page = await browser.newPage();
    try {
      await mount(page);
      const tree = {
        tag: 'svg',
        attributes: { onload: 'window.pwned = 1', viewBox: '0 0 10 10' },
        children: [
          { tag: 'script', attributes: {}, children: ['window.pwned = 1'] },
          {
            tag: 'foreignObject',
            attributes: {},
            children: [{ tag: 'iframe', attributes: { src: 'https://example.com' }, children: [] }],
          },
          { tag: 'a', attributes: { href: 'javascript:alert(1)' }, children: ['link'] },
          {
            tag: 'rect',
            attributes: {
              width: '10',
              fill: 'url(https://example.com/track)',
              onclick: 'window.pwned = 1',
              style: 'background: url(https://example.com/a)',
            },
            children: [],
          },
          {
            tag: 'style',
            attributes: {},
            children: ["@import url('https://example.com/a.css'); rect { fill: url(#local) }"],
          },
          { tag: 'path', attributes: { d: 'M0 0', 'marker-end': 'url(#arrow)' }, children: [] },
        ],
      };
      const html = await page.evaluate(value => window.buildDiagram(value), tree);
      expect(html).not.toMatch(/script|foreignObject|iframe|<a\b|onload|onclick|example\.com|@import/);
      expect(html).toContain('<rect width="10" style="background: none"');
      expect(html).toContain('rect { fill: url(#local) }');
      expect(html).toContain('marker-end="url(#arrow)"');
    } finally {
      await page.close();
    }
  }, 15000);
});

it('shows a date on hover for both assistant messages in the actual Message Actions story', async () => {
  const page = await newCoveredPage(browser);
  try {
    await mount(page);
    await page.evaluate(() => window.showMessageActions());
    const messages = page.locator('.glyph-entry.assistant');
    await expect(messages).toHaveCount(2);
    for (const message of await messages.all()) {
      await page.mouse.move(0, 0);
      await expect(message.locator('time')).toHaveCSS('opacity', '0');
      await message.hover();
      await expect(message.locator('time')).toHaveCSS('opacity', '1');
      await expect(message.locator('time')).toHaveAttribute('datetime', /2026-10-18T14:/u);
    }
  } finally {
    await page.close();
  }
});
