import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

const original = 'Original content\n';
const drawer = glyph => glyph.page.getByRole('region', { name: 'Pending reviews', exact: true });
const exists = path =>
  access(path).then(
    () => true,
    () => false,
  );
async function tool(glyph, provider, name, args) {
  const callId = randomUUID();
  const count = provider.requests.length;
  provider.enqueue({ output: [ScriptedProvider.tool(name, args, { callId })] }, { chunks: ['File change complete.'] });
  await glyph.send(`Run ${name}.`);
  await expect.poll(() => provider.requests.length).toBe(count + 2);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  const output = provider.requests
    .at(-1)
    .body.input.find(item => item.call_id === callId && item.type === 'function_call_output');
  return JSON.parse(output.output);
}
async function change(glyph, provider, operation) {
  const base =
    operation === 'CREATE'
      ? null
      : await tool(glyph, provider, 'read_project_file', { path: 'original.txt', start_line: null, end_line: null });
  const result = await tool(glyph, provider, 'propose_edits', {
    files: [
      {
        operation,
        path: operation === 'CREATE' ? 'created.json' : 'original.txt',
        new_path: operation === 'RENAME' ? 'renamed.txt' : null,
        base_revision: base?.revision ?? null,
        content: operation === 'CREATE' ? '{"created":true}\n' : null,
        byte_order_mark: null,
        edits: [],
      },
    ],
  });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'APPLIED_WITH_REVERT' });
  return operation === 'CREATE' ? 'created.json' : operation === 'RENAME' ? 'renamed.txt' : 'original.txt';
}
it.describe('Applied structural file changes', () => {
  it.use({ scriptedProvider: true, workspaceFiles: { 'original.txt': original } });
  for (const operation of ['CREATE', 'DELETE', 'RENAME']) {
    it(`${operation} applies immediately, renders its diff and survives reload with Revert`, async ({
      glyph,
      provider,
    }) => {
      const path = await change(glyph, provider, operation);
      await expect(drawer(glyph).getByRole('button', { name: `Revert ${path}`, exact: true })).toBeAttached();
      await expect(glyph.page.getByRole('region', { name: `File change ${path}`, exact: true })).toBeVisible();
      for (const surface of [
        drawer(glyph),
        glyph.page.getByRole('region', { name: `File change ${path}`, exact: true }),
      ]) {
        const icon = surface.locator('.file-icon');
        await expect(icon).toBeVisible();
        await expect
          .poll(() => icon.evaluate(element => getComputedStyle(element, '::before').content))
          .not.toMatch(/^(none|normal|""|)$/);
      }
      if (operation === 'DELETE') {
        expect(await exists(join(glyph.workspace, path))).toBe(false);
        await expect(drawer(glyph).getByText(path, { exact: true })).toHaveCSS('text-decoration-line', 'line-through');
      } else
        expect(await readFile(join(glyph.workspace, path), 'utf8')).toBe(
          operation === 'CREATE' ? '{"created":true}\n' : original,
        );
      if (operation === 'RENAME') {
        await expect(drawer(glyph).getByLabel('Renamed', { exact: true })).toHaveAttribute('title', 'Renamed');
        await expect(drawer(glyph)).not.toContainText('original.txt');
      }
      await drawer(glyph)
        .getByRole('button', { name: `Review ${path}`, exact: true })
        .click();
      await expect(glyph.page.locator('.monaco-diff-editor')).toBeVisible();
      await glyph.reload();
      await expect(drawer(glyph).getByRole('button', { name: `Revert ${path}`, exact: true })).toBeAttached();
      await drawer(glyph)
        .getByRole('button', { name: `Review ${path}`, exact: true })
        .hover();
      await drawer(glyph)
        .getByRole('button', { name: `Revert ${path}`, exact: true })
        .click();
      await expect(drawer(glyph)).toHaveCount(0);
      if (operation === 'CREATE') expect(await exists(join(glyph.workspace, path))).toBe(false);
      else expect(await readFile(join(glyph.workspace, 'original.txt'), 'utf8')).toBe(original);
      if (operation === 'RENAME') expect(await exists(join(glyph.workspace, path))).toBe(false);
    });
    it(`${operation} supports native workbench Undo`, async ({ glyph, provider }) => {
      const path = await change(glyph, provider, operation);
      await glyph.command('Focus on Files Explorer');
      await glyph.page.keyboard.press('ControlOrMeta+z');
      await expect
        .poll(() => exists(join(glyph.workspace, operation === 'CREATE' ? path : 'original.txt')))
        .toBe(operation !== 'CREATE');
      if (operation !== 'CREATE') expect(await readFile(join(glyph.workspace, 'original.txt'), 'utf8')).toBe(original);
      if (operation === 'RENAME') expect(await exists(join(glyph.workspace, path))).toBe(false);
    });
    it(`${operation} refuses Revert when it would overwrite subsequent work`, async ({ glyph, provider }) => {
      const path = await change(glyph, provider, operation);
      const protectedPath = operation === 'RENAME' ? 'original.txt' : path;
      await writeFile(join(glyph.workspace, protectedPath), 'USER WORK\n');
      await drawer(glyph)
        .getByRole('button', { name: `Review ${path}`, exact: true })
        .hover();
      await drawer(glyph)
        .getByRole('button', { name: `Revert ${path}`, exact: true })
        .click();
      await expect(drawer(glyph).getByRole('alert')).toBeVisible();
      expect(await readFile(join(glyph.workspace, protectedPath), 'utf8')).toBe('USER WORK\n');
    });
  }
  it('refuses an outside-workspace structural target without creating directories', async ({ glyph, provider }) => {
    const target = `../outside-${randomUUID()}/file.txt`;
    const result = await tool(glyph, provider, 'propose_edits', {
      files: [
        {
          operation: 'CREATE',
          path: target,
          new_path: null,
          base_revision: null,
          content: 'outside',
          byte_order_mark: null,
          edits: [],
        },
      ],
    });
    expect(result.error).toBeTruthy();
    expect(await exists(join(glyph.workspace, target, '..'))).toBe(false);
  });
});
