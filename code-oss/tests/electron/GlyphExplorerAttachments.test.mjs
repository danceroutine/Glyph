import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

it.use({
  scriptedProvider: true,
  workspaceFiles: {
    'alpha.txt': 'DISK ALPHA',
    'beta.txt': 'BETA CONTENT',
    'src/index.ts': 'PRIVATE FILE BODY',
    'src/nested/worker.ts': 'ANOTHER PRIVATE BODY',
  },
});

const item = (glyph, name) =>
  glyph.page.getByRole('tree', { name: 'Files Explorer', exact: true }).getByRole('treeitem', { name, exact: true });
async function attach(glyph, name, action) {
  // Native menus block pointer events outside the popup. Keep the fixture-only
  // notification handler from trying to click behind an open context menu.
  const notice = glyph.page.getByRole('dialog', { name: /All installed extensions are temporarily disabled/ });
  await glyph.page.removeLocatorHandler(notice);
  if (await notice.isVisible()) await notice.getByRole('button', { name: /^Clear Notification/ }).click();
  await item(glyph, name).click({ button: 'right' });
  const menuAction = glyph.page.getByRole('menuitem', { name: action, exact: true });
  await expect(menuAction).toBeVisible();
  await glyph.page.screenshot({ path: it.info().outputPath('explorer-context-menu.png') });
  await menuAction.click();
  glyph.extensionNoticeHandler = undefined;
  await glyph.dismissExtensionNotices();
}
async function send(glyph, provider) {
  provider.enqueue({ chunks: ['Context received.'] });
  await glyph.sendButton.click();
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  await expect.poll(() => provider.requests.length).toBeGreaterThan(0);
  const user = provider.requests
    .at(-1)
    .body.input.filter(value => value.role === 'user')
    .at(-1);
  return JSON.parse(user.content[0].text).files;
}

it('attaches selected Explorer files as badges using unsaved editor contents', async ({ glyph, provider }) => {
  await glyph.page.keyboard.press('ControlOrMeta+p');
  await glyph.page.locator('.quick-input-widget input').fill('alpha.txt');
  await glyph.page.getByRole('option', { name: 'alpha.txt, file results', exact: true }).click();
  await expect(glyph.page.locator('.quick-input-widget')).not.toBeVisible();
  await glyph.page.keyboard.press('ControlOrMeta+a');
  await glyph.page.keyboard.insertText('UNSAVED ALPHA');
  await glyph.composer.fill('Explain ');
  await item(glyph, 'alpha.txt').click();
  await item(glyph, 'beta.txt').click({ modifiers: ['ControlOrMeta'] });
  await attach(glyph, 'beta.txt', 'Add File to Glyph Chat');
  await expect(glyph.composer.getByRole('button', { name: 'Preview alpha.txt', exact: true })).toBeVisible();
  await expect(glyph.composer.getByRole('button', { name: 'Preview beta.txt', exact: true })).toBeVisible();
  await expect(glyph.composer).toContainText('Explain');
  expect(provider.requests).toHaveLength(0);
  const files = await send(glyph, provider);
  expect(files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'alpha.txt', text: 'UNSAVED ALPHA' }),
      expect.objectContaining({ path: 'beta.txt', text: 'BETA CONTENT' }),
    ]),
  );
  expect(files).toHaveLength(2);
});

for (const directory of [false, true]) {
  it(`adds an Explorer ${directory ? 'directory outline' : 'file'} to a new chat without sending or changing the old draft`, async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ chunks: ['Original response.'] });
    await glyph.send('Original task');
    await expect.poll(() => provider.requests.length).toBe(1);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await glyph.composer.fill('Keep this draft');
    const name = directory ? 'src' : 'beta.txt';
    await attach(glyph, name, `Add ${directory ? 'Directory' : 'File'} to New Glyph Chat`);
    await expect(glyph.userEntries).toHaveCount(0);
    await expect(glyph.composer).not.toContainText('Keep this draft');
    await glyph.composer.getByRole('button', { name: `Preview ${name}`, exact: true }).click();
    const preview = glyph.page.getByRole('region', { name: 'Attachment preview' });
    await expect(preview.locator('pre')).toContainText(directory ? 'index.ts' : 'BETA CONTENT');
    if (directory) {
      await expect(preview.locator('pre')).toContainText('worker.ts');
      await expect(preview.locator('pre')).not.toContainText('PRIVATE');
    }
    expect(provider.requests).toHaveLength(1);
    await preview.getByRole('button', { name: 'Close attachment preview' }).click();
    await glyph.page.getByRole('button', { name: 'Chat history', exact: true }).click();
    await glyph.page
      .getByRole('navigation', { name: 'Saved chats' })
      .getByRole('button')
      .filter({ hasText: /Original task/i })
      .click();
    if (
      (await glyph.page.getByRole('button', { name: 'Chat history', exact: true }).getAttribute('aria-expanded')) ===
      'true'
    )
      await glyph.page.getByRole('button', { name: 'Chat history', exact: true }).click();
    await expect(glyph.composer).toHaveText('Keep this draft');
  });
}

it('adds an Explorer directory to the current draft using a folder badge', async ({ glyph, provider }) => {
  await glyph.composer.fill('Explain ');
  await glyph.page.getByRole('button', { name: 'Chat actions', exact: true }).click();
  await glyph.page.getByRole('menuitem', { name: 'Hide Chat', exact: true }).click();
  await expect(glyph.composer).not.toBeVisible();
  await attach(glyph, 'src', 'Add Directory to Glyph Chat');
  await expect(glyph.composer.getByRole('button', { name: 'Preview src', exact: true })).toBeVisible();
  const files = await send(glyph, provider);
  expect(files).toHaveLength(1);
  expect(files[0].text).toContain('Directory tree: src');
  expect(files[0].text).toContain('index.ts');
  expect(files[0].text).not.toContain('PRIVATE');
});

it('keeps an unsent draft recoverable when adding to a new chat', async ({ glyph, provider }) => {
  await glyph.composer.fill('Keep my unsent prompt');
  await attach(glyph, 'beta.txt', 'Add File to New Glyph Chat');
  await expect(glyph.composer).toHaveText('beta.txt');
  await expect(glyph.page.getByRole('region', { name: 'Unsent messages' })).toContainText('Keep my unsent prompt');
  expect(provider.requests).toHaveLength(0);
});

it('keeps the chat and draft unchanged when a selected file cannot be captured', async ({ glyph, provider }) => {
  provider.enqueue({ chunks: ['Original response.'] });
  await glyph.send('Original task');
  await expect.poll(() => provider.requests.length).toBe(1);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  await glyph.composer.fill('Keep this draft');
  await writeFile(join(glyph.workspace, 'alpha.txt'), 'x'.repeat(512 * 1024 + 1));
  await item(glyph, 'alpha.txt').click();
  await item(glyph, 'beta.txt').click({ modifiers: ['ControlOrMeta'] });
  await attach(glyph, 'beta.txt', 'Add File to New Glyph Chat');
  await expect(glyph.page.locator('.notifications-toasts')).toContainText(/512 KiB|READ_LIMIT_EXCEEDED/);
  await expect(glyph.composer).toHaveText('Keep this draft');
  await expect(glyph.composer.getByRole('button')).toHaveCount(0);
  await expect(glyph.userEntries).toHaveCount(1);
  expect(provider.requests).toHaveLength(1);
});
