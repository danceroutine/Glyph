import { randomUUID } from 'node:crypto';
import { editToolOutput, parseJson } from './ProviderPayloads.mjs';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

/** @typedef {import('./GlyphWorkbench.mjs').GlyphWorkbench} GlyphWorkbench */

/**
 * @param {GlyphWorkbench} glyph
 * @param {ScriptedProvider} provider
 * @param {string} name
 * @param {unknown} args
 */
async function tool(glyph, provider, name, args) {
  const callId = randomUUID();
  const count = provider.requests.length;
  provider.enqueue({ output: [ScriptedProvider.tool(name, args, { callId })] }, { chunks: ['Ready for review.'] });
  await glyph.send(`Run ${name}.`);
  await expect.poll(() => provider.requests.length).toBe(count + 2);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  return editToolOutput.parse(
    parseJson(
      provider.requests.at(-1)?.body.input.find(item => item.call_id === callId && item.type === 'function_call_output')
        ?.output,
    ),
  );
}

for (const rebound of [false, true]) {
  it.describe(rebound ? 'Rebound review toolbar' : 'Default review toolbar', () => {
    const modifier = process.platform === 'darwin' ? 'cmd' : 'ctrl';
    const bindings = [
      ['keepFile', `${modifier}+enter`, 'alt+k'],
      ['keepAll', `${modifier}+shift+enter`, 'alt+a'],
      ['nextFile', `${modifier}+alt+right`, 'alt+l'],
      ['previousFile', `${modifier}+alt+left`, 'alt+h'],
      ['keep', `${modifier}+y`, 'alt+y'],
    ];
    it.use({
      scriptedProvider: true,
      workspaceFiles: {
        'first.ts': 'const first = 1;\n',
        'second.ts': 'const second = 1;\n',
        'third.ts': 'const third = 1;\n',
      },
      userKeybindings: [
        rebound
          ? bindings.flatMap(([id, original, key]) => [
              { key: original, command: `-glyph.review.${id}` },
              { key, command: `glyph.review.${id}`, when: 'glyph.reviewEditor && !glyph.reviewTextInput' },
            ])
          : [],
        { scope: 'test' },
      ],
    });
    it('shows resolved shortcuts, navigates files, and changes to the completed toolbar for file and inline decisions', async ({
      glyph,
      provider,
    }) => {
      const files = [];
      for (const name of ['first', 'second', 'third']) {
        const path = `${name}.ts`;
        const base = await tool(glyph, provider, 'read_project_file', { path, start_line: null, end_line: null });
        files.push({
          operation: 'UPDATE',
          path,
          new_path: null,
          base_revision: base.revision,
          content: `const ${name} = 2;\n`,
          byte_order_mark: null,
          edits: [],
        });
      }
      await tool(glyph, provider, 'propose_edits', { files });
      const pending = glyph.page.getByRole('region', { name: 'Pending reviews', exact: true });
      await pending.getByRole('button', { name: 'Review first.ts', exact: true }).click();
      const toolbar = glyph.page.getByRole('region', { name: 'File review controls', exact: true }).last();
      const keepFile = toolbar.getByRole('button', { name: 'Keep File', exact: true });
      const keepAll = toolbar.getByRole('button', { name: 'Keep all changes', exact: true });
      await expect(keepFile.locator('kbd')).not.toBeEmpty();
      if (rebound) await expect(keepFile.locator('kbd')).toContainText('K');
      await expect(keepAll).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(keepAll).toHaveCSS('border-top-width', '1px');
      await expect(toolbar.getByRole('button', { name: 'Previous change' })).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)',
      );
      await keepFile.focus();
      await glyph.page.keyboard.press(rebound ? 'Alt+l' : 'ControlOrMeta+Alt+ArrowRight');
      await expect(toolbar).toContainText('2 of 3 Files');
      await toolbar.getByRole('button', { name: 'Keep File', exact: true }).focus();
      await glyph.page.keyboard.press(rebound ? 'Alt+h' : 'ControlOrMeta+Alt+ArrowLeft');
      await expect(toolbar).toContainText('1 of 3 Files');
      await keepFile.focus();
      if (rebound) {
        await glyph.page.keyboard.press('ControlOrMeta+Enter');
        await expect(keepFile).toBeVisible();
      }
      await glyph.page.keyboard.press(rebound ? 'Alt+k' : 'ControlOrMeta+Enter');
      await expect(keepFile).toHaveCount(0);
      await expect(toolbar.getByRole('button')).toHaveCount(2);
      const next = toolbar.getByRole('button', { name: 'Review Next File', exact: true });
      await expect(next.locator('kbd')).not.toBeEmpty();
      await expect(keepAll.locator('kbd')).not.toBeEmpty();
      expect((await next.boundingBox()).x).toBeLessThan((await keepAll.boundingBox()).x);
      await next.focus();
      await glyph.page.keyboard.press(rebound ? 'Alt+l' : 'ControlOrMeta+Alt+ArrowRight');
      await expect(keepFile).toBeVisible();
      const inlineKeep = glyph.page
        .getByRole('region', { name: 'Edit review controls', exact: true })
        .getByRole('button', { name: 'Keep', exact: true });
      await inlineKeep.focus();
      await glyph.page.keyboard.press(rebound ? 'Alt+y' : 'ControlOrMeta+y');
      await expect(keepFile).toHaveCount(0);
      await expect(inlineKeep).toHaveCount(0);
      await expect(toolbar.getByRole('button')).toHaveCount(2);
      await keepAll.focus();
      await glyph.page.keyboard.press(rebound ? 'Alt+a' : 'ControlOrMeta+Shift+Enter');
      await expect(pending).toHaveCount(0);
      await expect(keepAll).toBeDisabled();
      await expect(next).toBeDisabled();
    });
  });
}
