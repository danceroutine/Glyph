import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

it.use({
  scriptedProvider: true,
  workspaceFiles: {
    'src/index.ts': 'PRIVATE FILE CONTENT MUST NOT BE ATTACHED',
    'src/nested/worker.ts': 'ANOTHER PRIVATE BODY',
  },
});

it('captures a folder tree without file contents and preserves it through restore until refresh', async ({
  glyph,
  provider,
}) => {
  await glyph.composer.pressSequentially('Explain @src/');
  const folder = glyph.page.getByRole('option', { name: 'src/', exact: true });
  await expect(folder).toBeVisible();
  await folder.click();
  await expect(glyph.composer).toHaveText('Explain src');
  await glyph.composer.getByRole('button', { name: 'Preview src', exact: true }).click();
  const preview = glyph.page.getByRole('region', { name: 'Attachment preview' });
  await expect(preview.locator('pre')).toContainText('index.ts');
  await expect(preview.locator('pre')).toContainText('nested/\n  worker.ts');
  await expect(preview.locator('pre')).not.toContainText('PRIVATE');
  const captured = await preview.locator('pre').innerText();
  await writeFile(join(glyph.workspace, 'src/added.ts'), 'NEW PRIVATE CONTENT');
  await expect(preview.locator('pre')).toHaveText(captured);
  await preview.getByRole('button', { name: 'Close attachment preview' }).click();
  provider.enqueue({ chunks: ['Tree received.'] });
  await glyph.sendButton.click();
  await expect.poll(() => provider.requests.length).toBe(1);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  const sent = JSON.stringify(provider.requests[0].body);
  expect(sent).toContain('index.ts');
  expect(sent).not.toContain('PRIVATE');
  expect(sent).not.toContain('added.ts');
  await glyph.crashHost();
  await glyph.reload();
  await glyph.userEntries.hover();
  await glyph.userEntries.getByRole('button', { name: 'Restore checkpoint' }).click();
  await expect(glyph.composer).toHaveText('Explain src');
  await glyph.composer.getByRole('button', { name: 'Preview src', exact: true }).click();
  await expect(preview.locator('pre')).toHaveText(captured);
  await preview.getByRole('button', { name: 'Refresh capture', exact: true }).click();
  await expect(preview.locator('pre')).toContainText('added.ts');
  await expect(preview.locator('pre')).not.toContainText('PRIVATE');
});
