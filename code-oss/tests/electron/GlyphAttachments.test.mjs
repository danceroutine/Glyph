import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

async function openFile(glyph, path) {
  await glyph.page.keyboard.press('ControlOrMeta+p');
  await glyph.page.locator('.quick-input-widget input').fill(path);
  await glyph.page.keyboard.press('Enter');
  await expect(glyph.page.locator('.quick-input-widget')).not.toBeVisible();
  await expect(glyph.page.locator('.editor-instance .monaco-editor').first()).toBeVisible();
}
async function selectLine(glyph, line) {
  await glyph.page.keyboard.press('Control+g');
  await glyph.page.locator('.quick-input-widget input').fill(`:${line}:1`);
  await glyph.page.keyboard.press('Enter');
  await expect(glyph.page.locator('.quick-input-widget')).not.toBeVisible();
  await glyph.page.keyboard.press('Shift+End');
}
async function attachSelection(glyph) {
  await glyph.page.keyboard.press('ControlOrMeta+l');
  await expect(glyph.composer.getByRole('button').last()).toBeVisible();
}
async function chooseFile(glyph, query) {
  await glyph.composer.pressSequentially(` @${query}`);
  await expect(glyph.page.getByRole('option', { name: query, exact: true })).toBeVisible();
  await glyph.composer.press('Enter');
  await expect(glyph.page.getByRole('listbox', { name: 'Files and folders to attach' })).not.toBeVisible();
}
async function send(glyph, provider) {
  const count = provider.requests.length;
  provider.enqueue({ chunks: ['Captured context received.'] });
  await glyph.sendButton.click();
  await expect.poll(() => provider.requests.length).toBe(count + 1);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  const user = provider.requests
    .at(-1)
    .body.input.filter(item => item.role === 'user')
    .at(-1);
  return {
    prompt: typeof user.content === 'string' ? user.content : user.content[1].text,
    files: typeof user.content === 'string' ? [] : JSON.parse(user.content[0].text).files,
  };
}

it.describe('Explicit editor and file attachments', () => {
  it.use({
    scriptedProvider: true,
    workspaceFiles: {
      'alpha.txt': 'OUTSIDE BEFORE\n  café 🌱\nOUTSIDE AFTER\n',
      'beta.txt': 'Other tab is never implicit.\n',
      'empty.txt': '',
    },
  });
  it('restores inline file badges with their original snapshots after the source changes', async ({
    glyph,
    provider,
  }) => {
    await glyph.composer.fill('Explain');
    await chooseFile(glyph, 'alpha.txt');
    await glyph.composer.pressSequentially(' please');
    const original = await send(glyph, provider);
    await expect(glyph.userEntries.getByRole('button', { name: 'Restore checkpoint' })).toHaveCount(1);
    await writeFile(join(glyph.workspace, 'alpha.txt'), 'Changed after the checkpoint.');
    await glyph.crashHost();
    await glyph.reload();
    await glyph.userEntries.hover();
    await glyph.userEntries.getByRole('button', { name: 'Restore checkpoint' }).click();
    await expect(glyph.userEntries).toHaveCount(0);
    await expect(glyph.composer).toHaveText('Explain alpha.txt please');
    await expect(glyph.composer.getByRole('button', { name: 'Preview alpha.txt', exact: true })).toBeVisible();
    const resent = await send(glyph, provider);
    expect(resent.prompt).toBe(original.prompt);
    expect(resent.files).toEqual(original.files);
    expect(resent.files[0].text).toContain('café 🌱');
    expect(resent.files[0].text).not.toContain('Changed after');
  });

  it('opens the native file dialog from the paperclip, preserves cancellation, and captures selected files', async ({
    glyph,
    provider,
  }) => {
    // Stub only the OS dialog boundary: UI activation, native IPC, and file capture stay real.
    await glyph.application.evaluate(({ dialog }, workspace) => {
      globalThis.glyphFileDialogs = [];
      dialog.showOpenDialog = async (_window, options) => {
        globalThis.glyphFileDialogs.push(options);
        const canceled = globalThis.glyphFileDialogs.length === 1;
        return { canceled, filePaths: canceled ? [] : [`${workspace}/alpha.txt`, `${workspace}/empty.txt`] };
      };
    }, glyph.workspace);
    await glyph.composer.fill('before  after');
    for (let index = 0; index < 6; index++) await glyph.composer.press('ArrowLeft');
    const attach = glyph.page.getByRole('button', { name: 'Attach file', exact: true });
    await attach.click();
    await expect.poll(() => glyph.application.evaluate(() => globalThis.glyphFileDialogs.length)).toBe(1);
    await expect(attach).toBeEnabled();
    await expect(glyph.composer).toHaveText('before  after');
    await attach.click();
    await expect(glyph.composer).toHaveText('before alpha.txtempty.txt after');
    await expect(glyph.page.getByRole('listbox', { name: 'Files and folders to attach' })).toHaveCount(0);
    const dialogs = await glyph.application.evaluate(() => globalThis.glyphFileDialogs);
    expect(dialogs).toHaveLength(2);
    expect(dialogs[0]).toMatchObject({
      title: 'Attach files to Glyph',
      properties: expect.arrayContaining(['openFile', 'multiSelections']),
    });
    expect(dialogs[0].properties).not.toContain('openDirectory');
    const sent = await send(glyph, provider);
    expect(sent.files).toMatchObject([
      { path: 'alpha.txt', text: 'OUTSIDE BEFORE\n  café 🌱\nOUTSIDE AFTER\n' },
      { path: 'empty.txt', text: '' },
    ]);
    expect(sent.prompt).toBe('before @alpha.txt@empty.txt after');
  });

  it('inserts an unsaved whole file at the prompt caret and keeps it pinned while the active editor changes', async ({
    glyph,
    provider,
  }) => {
    const path = join(glyph.workspace, 'alpha.txt');
    await openFile(glyph, path);
    await glyph.page.keyboard.press('ControlOrMeta+a');
    await glyph.page.keyboard.insertText('UNSAVED café 🌱\nexact buffer');
    await glyph.command('Focus Glyph');
    await expect(glyph.page.getByRole('button', { name: /^Attach active file/ })).toHaveCount(0);
    await expect(glyph.page.getByText('No active text editor', { exact: true })).toHaveCount(0);
    await glyph.composer.fill('before  after');
    for (let n = 0; n < 6; n++) await glyph.composer.press('ArrowLeft');
    await glyph.composer.pressSequentially('@alpha');
    await expect(glyph.page.getByRole('option', { name: 'alpha.txt', exact: true })).toBeVisible();
    await glyph.composer.press('Enter');
    await expect(glyph.composer).toHaveText('before alpha.txt after');
    await glyph.composer.press('Backspace');
    await expect(glyph.composer.getByRole('button')).toHaveCount(0);
    await glyph.composer.press('ControlOrMeta+z');
    await expect(glyph.composer).toHaveText('before alpha.txt after');
    await expect(glyph.page.locator('.tab.dirty')).toHaveCount(1);
    await openFile(glyph, join(glyph.workspace, 'beta.txt'));
    await glyph.command('Focus Glyph');
    await expect(glyph.page.getByRole('button', { name: /^Attach active file/ })).toHaveCount(0);
    await expect(glyph.composer.getByRole('button', { name: 'Preview alpha.txt' })).toBeVisible();
    const sent = await send(glyph, provider);
    expect(sent.prompt).toBe('before @alpha.txt after');
    const message = glyph.page.locator('.glyph-entry.user').last();
    await expect(message.locator('[data-glyph-source]')).toHaveText('before alpha.txt after');
    await message.getByRole('button', { name: 'Open alpha.txt', exact: true }).click();
    await expect(glyph.page.locator('.tab.active')).toContainText('alpha.txt');
    await expect(glyph.page.locator('.editor-instance .view-lines').first()).toContainText('UNSAVED');
    expect(sent.files).toHaveLength(1);
    expect(sent.files[0]).toMatchObject({
      path: 'alpha.txt',
      text: 'UNSAVED café 🌱\nexact buffer',
      source: { kind: 'file', version: expect.any(Number), revision: expect.any(String) },
    });
    expect(await readFile(path, 'utf8')).toContain('OUTSIDE BEFORE');
  });

  it('attaches only highlighted text with Cmd+L, previews exact capture, refreshes explicitly, and preserves sent history', async ({
    glyph,
    provider,
  }) => {
    const path = join(glyph.workspace, 'alpha.txt');
    await glyph.composer.fill('Explain ');
    await openFile(glyph, path);
    await selectLine(glyph, 2);
    await attachSelection(glyph);
    expect(provider.requests).toHaveLength(0);
    const badge = glyph.composer.getByRole('button', { name: 'Preview alpha.txt (2-2)', exact: true });
    await badge.click();
    const preview = glyph.page.getByRole('region', { name: 'Attachment preview' });
    await expect(preview.locator('pre')).toHaveText('  café 🌱');
    await preview.getByRole('button', { name: 'Close attachment preview' }).click();
    await openFile(glyph, path);
    await selectLine(glyph, 2);
    await glyph.page.keyboard.insertText('  zoom 🌱');
    await glyph.command('Focus Glyph');
    await badge.click();
    await expect(preview).toContainText('Source changed');
    await expect(preview.locator('pre')).toHaveText('  café 🌱');
    await preview.getByRole('button', { name: 'Refresh capture' }).click();
    // Refresh uses the original range, not the current cursor or the whole file.
    await expect(preview.locator('pre')).toHaveText('  zoom 🌱');
    await preview.getByRole('button', { name: 'Close attachment preview' }).click();
    const sent = await send(glyph, provider);
    expect(sent.files).toHaveLength(1);
    expect(sent.files[0]).toMatchObject({
      text: '  zoom 🌱',
      source: { kind: 'selection', range: { start: { line: 2, column: 1 }, end: { line: 2, column: 10 } } },
    });
    expect(JSON.stringify(sent.files)).not.toContain('OUTSIDE');
    await openFile(glyph, path);
    await glyph.page.keyboard.press('ControlOrMeta+a');
    await glyph.page.keyboard.insertText('Entirely different current source');
    await glyph.page.keyboard.press('ControlOrMeta+s');
    await glyph.reload();
    const message = glyph.page.locator('.glyph-entry.user').last();
    await expect(message.getByLabel('Captured attachment alpha.txt')).toHaveCount(0);
    await message.getByRole('button', { name: 'Open alpha.txt (2-2)', exact: true }).click();
    await expect(glyph.page.locator('.tab.active')).toContainText('alpha.txt');
    await expect(glyph.page.locator('.editor-instance .view-lines').first()).toContainText(
      'Entirely different current source',
    );
  });

  it('keeps multiple files independently removable and reports a deleted source while retaining captured bytes', async ({
    glyph,
    provider,
  }) => {
    await glyph.composer.fill('Compare');
    await chooseFile(glyph, 'alpha.txt');
    await glyph.composer.pressSequentially(' with');
    await chooseFile(glyph, 'beta.txt');
    const preview = glyph.page.getByRole('region', { name: 'Attachment preview' });
    await glyph.composer.getByRole('button', { name: 'Preview alpha.txt', exact: true }).click();
    await preview.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(glyph.composer).toHaveText('Compare  with beta.txt');
    await rm(join(glyph.workspace, 'beta.txt'));
    await glyph.composer.getByRole('button', { name: 'Preview beta.txt', exact: true }).click();
    await expect(preview).toContainText('Source deleted');
    await expect(preview.locator('pre')).toHaveText('Other tab is never implicit.\n');
    await preview.getByRole('button', { name: 'Close attachment preview' }).click();
    const sent = await send(glyph, provider);
    expect(sent.files.map(file => file.path)).toEqual(['beta.txt']);
    expect(sent.files[0].text).toBe('Other tab is never implicit.\n');
    const message = glyph.page.locator('.glyph-entry.user').last();
    await message.getByRole('button', { name: 'Open beta.txt', exact: true }).click();
    await expect(message.getByRole('alert')).toContainText('Source deleted');
  });

  it('captures separate multicursor ranges, preserving Unicode, tabs and CRLF without sending surrounding text', async ({
    glyph,
    provider,
  }) => {
    const path = join(glyph.workspace, 'alpha.txt');
    await writeFile(path, 'outside\r\n\tcafé 🌱\r\n\tcafé 🌱\r\noutside\r\n');
    await glyph.composer.fill('Explain both ');
    await openFile(glyph, path);
    await selectLine(glyph, 2);
    await glyph.page.keyboard.press('ControlOrMeta+d');
    await attachSelection(glyph);
    await expect(glyph.composer.getByRole('button')).toHaveCount(2);
    const sent = await send(glyph, provider);
    expect(sent.files.map(file => file.text)).toEqual(['\tcafé 🌱', '\tcafé 🌱']);
    expect(sent.files.map(file => file.source.range.start.line)).toEqual([2, 3]);
    await openFile(glyph, path);
    await selectLine(glyph, 2);
    await glyph.page.keyboard.press('Shift+ArrowDown');
    await attachSelection(glyph);
    const multiline = await send(glyph, provider);
    expect(multiline.files[0].text).toBe('\tcafé 🌱\r\n\tcafé 🌱');
  });

  it('uses the focused split editor and identifies the original and modified sides of a diff', async ({
    glyph,
    provider,
  }) => {
    await openFile(glyph, join(glyph.workspace, 'alpha.txt'));
    await glyph.command('View: Split Editor Right');
    await openFile(glyph, join(glyph.workspace, 'beta.txt'));
    await glyph.command('View: Focus First Editor Group');
    await selectLine(glyph, 2);
    await attachSelection(glyph);
    await glyph.command('View: Focus Last Editor Group');
    await selectLine(glyph, 1);
    await attachSelection(glyph);
    const split = await send(glyph, provider);
    expect(split.files.map(file => [file.path, file.text])).toEqual([
      ['alpha.txt', '  café 🌱'],
      ['beta.txt', 'Other tab is never implicit.'],
    ]);
    await glyph.command('View: Join All Editor Groups');
    await glyph.page.keyboard.press('ControlOrMeta+b');
    await openFile(glyph, join(glyph.workspace, 'alpha.txt'));
    await glyph.command('File: Compare Active File With...');
    await glyph.page.locator('.quick-input-widget input').fill('beta.txt');
    await glyph.page.keyboard.press('Enter');
    const diff = glyph.page.locator('.monaco-diff-editor');
    await expect(diff).toBeVisible();
    for (const side of ['original', 'modified']) {
      await diff.locator(`.editor.${side}`).getByRole('textbox').focus();
      await glyph.page.keyboard.press('ControlOrMeta+a');
      await attachSelection(glyph);
    }
    const compared = await send(glyph, provider);
    expect(compared.files.map(file => file.source.side)).toEqual(['original', 'modified']);
    expect(compared.files.map(file => file.text).sort()).toEqual(
      ['OUTSIDE BEFORE\n  café 🌱\nOUTSIDE AFTER\n', 'Other tab is never implicit.\n'].sort(),
    );
  });

  // Explorer file and folder context-menu entry points run in GlyphExplorerAttachments.test.mjs.

  it.fixme('investigate and revisit the 512 KiB per-file attachment limit', async () => {
    // Evaluate why this cap exists and whether to raise it or make it configurable,
    // accounting for provider context budgets and aggregate attachment limits.
  });

  it('reports unsupported sources and oversized captures without dropping draft text or sending partial data', async ({
    glyph,
    provider,
  }) => {
    await glyph.composer.fill('Keep this draft');
    await glyph.command('Preferences: Open User Settings (JSON)');
    await glyph.page.keyboard.press('ControlOrMeta+a');
    await glyph.page.keyboard.press('ControlOrMeta+l');
    await expect(glyph.page.locator('.notifications-toasts')).toContainText('UNSUPPORTED_RESOURCE');
    await writeFile(join(glyph.workspace, 'large.txt'), 'x'.repeat(512 * 1024 + 1));
    await glyph.composer.press('ControlOrMeta+a');
    await glyph.composer.press('ArrowRight');
    await glyph.composer.pressSequentially(' @large.txt');
    await expect(glyph.page.getByRole('option', { name: 'large.txt', exact: true })).toBeVisible();
    await glyph.composer.press('Enter');
    await expect(glyph.page.locator('.glyph-composer').getByRole('alert')).toContainText('512 KiB');
    await expect(glyph.composer).toHaveText('Keep this draft @large.txt');
    expect(provider.requests).toHaveLength(0);
  });

  it('restores exact selection badges after a rejected send and keeps them editable across pane remounts', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ chunks: ['Owner running'], hold: true });
    await glyph.send('Hold ownership');
    await expect(glyph.sendButton).toHaveText('Cancel');
    const duplicate = await glyph.duplicateWorkspace();
    await duplicate.composer.fill('Preserve ');
    await openFile(duplicate, join(glyph.workspace, 'alpha.txt'));
    await selectLine(duplicate, 2);
    await attachSelection(duplicate);
    await duplicate.sendButton.click();
    await expect(duplicate.page.locator('.glyph-composer').getByRole('alert')).toContainText('owned by window');
    await expect(duplicate.composer.getByRole('button', { name: 'Preview alpha.txt (2-2)' })).toBeVisible();
    await duplicate.command('View: Toggle Secondary Side Bar Visibility');
    await duplicate.command('Focus Glyph');
    await duplicate.composer.getByRole('button', { name: 'Preview alpha.txt (2-2)' }).click();
    const preview = duplicate.page.getByRole('region', { name: 'Attachment preview' });
    await expect(preview.locator('pre')).toHaveText('  café 🌱');
    await preview.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(duplicate.composer).toHaveText('Preserve ');
    expect(provider.requests).toHaveLength(1);
    provider.release(0);
  });

  it('allows empty and untitled buffers explicitly without automatically attaching another open tab', async ({
    glyph,
    provider,
  }) => {
    await openFile(glyph, join(glyph.workspace, 'empty.txt'));
    await glyph.command('Focus Glyph');
    await chooseFile(glyph, 'empty.txt');
    await expect(glyph.composer.getByRole('button', { name: 'Preview empty.txt', exact: true })).toBeVisible();
    const empty = await send(glyph, provider);
    expect(empty.files).toMatchObject([{ path: 'empty.txt', text: '' }]);
    await glyph.command('File: New Untitled Text File');
    await glyph.page.keyboard.insertText('Unsaved untitled source');
    await glyph.page.keyboard.press('ControlOrMeta+a');
    await attachSelection(glyph);
    const untitled = await send(glyph, provider);
    expect(untitled.files).toHaveLength(1);
    expect(untitled.files[0]).toMatchObject({
      path: 'Untitled-1',
      text: 'Unsaved untitled source',
      source: { uri: 'untitled:Untitled-1', kind: 'selection' },
    });
  });
});

it.describe('Workspace-qualified attachment picker', () => {
  it.use({
    scriptedProvider: true,
    workspaceFiles: { 'shared.txt': 'First root' },
    additionalRoots: [[{ name: 'second', files: { 'shared.txt': 'Second root' } }], { scope: 'test' }],
  });
  it('distinguishes same-named files and sends only explicitly chosen roots', async ({ glyph, provider }) => {
    await glyph.composer.fill('Compare');
    await chooseFile(glyph, 'workspace/shared.txt');
    await glyph.composer.pressSequentially(' and');
    await chooseFile(glyph, 'second/shared.txt');
    const sent = await send(glyph, provider);
    expect(sent.files.map(file => [file.path, file.text])).toEqual([
      ['workspace/shared.txt', 'First root'],
      ['second/shared.txt', 'Second root'],
    ]);
  });
});
