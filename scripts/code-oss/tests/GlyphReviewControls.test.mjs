import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { beforeAll, afterAll, it } from 'vitest';
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
      import { InEditor } from './code-oss/ui/GlyphReviewControls/GlyphReviewControls.stories.tsx';
      import { stageClassName } from './code-oss/storybook/previewStyles.ts';
      document.body.className = stageClassName;
      render(h(InEditor.render, {}), document.getElementById('root'));
    `,
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
    })
  ).outputFiles[0].text;
  browser = await chromium.launch();
}, 30000);
afterAll(async () => {
  await browser?.close();
});

for (const inline of [false, true]) {
  it(`finishes a file through ${inline ? 'inline decisions' : 'Keep File'} and keeps global acceptance on the right`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const toolbar = page.getByRole('region', { name: 'File review controls', exact: true });
      const keepFile = toolbar.getByRole('button', { name: 'Keep File', exact: true });
      const keepAll = toolbar.getByRole('button', { name: 'Keep all changes', exact: true });
      await expect(keepFile.locator('kbd')).toHaveText('⌘↵');
      await expect(keepAll).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const green = await keepFile.evaluate(el => getComputedStyle(el).backgroundColor);
      await expect(keepAll).toHaveCSS('border-top-color', green);
      await expect(keepAll).toHaveCSS('color', await toolbar.evaluate(el => getComputedStyle(el).color));
      await expect(toolbar.getByRole('button', { name: 'Next change', exact: true })).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)',
      );
      if (inline) {
        await page
          .getByRole('region', { name: 'Edit review controls', exact: true })
          .first()
          .getByRole('button', { name: 'Keep', exact: true })
          .click();
        await expect(keepFile).toBeVisible();
        await page
          .getByRole('region', { name: 'Edit review controls', exact: true })
          .getByRole('button', { name: 'Revert', exact: true })
          .click();
      } else await keepFile.click();
      await expect(keepFile).toHaveCount(0);
      await expect(toolbar.getByRole('button')).toHaveCount(2);
      const next = toolbar.getByRole('button', { name: 'Review Next File', exact: true });
      await expect(next.locator('kbd')).toHaveText('⌘⌥→');
      await expect(keepAll.locator('kbd')).toHaveText('⇧⌘↵');
      expect((await next.boundingBox()).x).toBeLessThan((await keepAll.boundingBox()).x);
      await next.click();
      await expect(keepFile).toBeVisible();
      await expect(page.locator('header')).toContainText('worker.ts');
      await keepAll.click();
      await expect(keepAll).toBeDisabled();
      await expect(page.getByRole('region', { name: 'Edit review controls', exact: true })).toHaveCount(0);
    } finally {
      await page.close();
    }
  });
}

it('shortens Keep all changes before wrapping and restores its label when space returns', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const toolbar = page.getByRole('region', { name: 'File review controls', exact: true });
    const keepAll = toolbar.getByRole('button', { name: 'Keep all changes', exact: true });
    await expect(keepAll).toBeVisible();
    const width = await toolbar.evaluate(node => {
      // The longer Revert label can make the initial toolbar compact already.
      // Measure its expanded content rather than subtracting from that compact width.
      const row = node.firstElementChild.cloneNode(true);
      Object.assign(row.style, { position: 'fixed', visibility: 'hidden', width: 'max-content', flexWrap: 'nowrap' });
      row.querySelector('[data-keep-all-suffix]').removeAttribute('hidden');
      node.append(row);
      const width = row.getBoundingClientRect().width + 8;
      row.remove();
      return width;
    });
    await toolbar.evaluate((node, width) => {
      node.style.width = `${width - 20}px`;
    }, width);
    await expect.poll(() => keepAll.innerText()).not.toContain('changes');
    const centers = await toolbar.locator('button').evaluateAll(buttons =>
      buttons.map(button => {
        const bounds = button.getBoundingClientRect();
        return bounds.y + bounds.height / 2;
      }),
    );
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
    await toolbar.evaluate((node, width) => {
      node.style.width = `${width + 30}px`;
    }, width);
    await expect.poll(() => keepAll.innerText()).toContain('changes');
  } finally {
    await page.close();
  }
});
