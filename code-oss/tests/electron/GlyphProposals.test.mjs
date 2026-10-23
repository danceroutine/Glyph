import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, isolatedLaunch, test as it } from './GlyphWorkbench.fixture.mjs';
import { contextEventMessage, editToolOutput, parseJson } from './ProviderPayloads.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

/** @typedef {import('./GlyphWorkbench.mjs').GlyphWorkbench} GlyphWorkbench */

const original = 'one\nunchanged\nthree\n';
const changed = 'ONE\nunchanged\nTHREE\n';
const reloadsWindow = isolatedLaunch('reloads the window');
/** @param {GlyphWorkbench} glyph */
const pending = glyph => glyph.page.getByRole('region', { name: 'Pending reviews', exact: true });
/** @param {GlyphWorkbench} glyph */
const fileControls = glyph => glyph.page.getByRole('region', { name: 'File review controls', exact: true }).last();
/** @param {GlyphWorkbench} glyph */
const controls = glyph => glyph.page.getByRole('region', { name: 'Edit review controls', exact: true }).first();

/**
 * @param {GlyphWorkbench} glyph
 * @param {ScriptedProvider} provider
 * @param {string} name
 * @param {unknown} args
 * @param {'json' | 'text'} [inputKind]
 */
async function tool(glyph, provider, name, args, inputKind = 'json') {
  const callId = randomUUID();
  const count = provider.requests.length;
  provider.enqueue(
    { output: [ScriptedProvider.tool(name, args, { callId, inputKind })] },
    { chunks: ['Ready for review.'] },
  );
  await glyph.send(`Run ${name}.`);
  await expect.poll(() => provider.requests.length).toBe(count + 2);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  const output = provider.requests
    .at(-1)
    ?.body.input.find(
      item =>
        item.call_id === callId && (item.type === 'function_call_output' || item.type === 'custom_tool_call_output'),
    );
  return editToolOutput.parse(parseJson(output?.output));
}
/**
 * @param {GlyphWorkbench} glyph
 * @param {ScriptedProvider} provider
 */
async function read(glyph, provider, path = 'review.txt') {
  return tool(glyph, provider, 'read_project_file', { path, start_line: null, end_line: null });
}
/**
 * @param {string} path
 * @param {string | null | undefined} revision
 * @param {string | null} content
 * @param {unknown[]} [edits]
 */
function structured(path, revision, content, edits = []) {
  return { operation: 'UPDATE', path, new_path: null, base_revision: revision, content, byte_order_mark: null, edits };
}
/**
 * @param {GlyphWorkbench} glyph
 * @param {ScriptedProvider} provider
 */
async function stage(glyph, provider, content = changed, path = 'review.txt') {
  const base = await read(glyph, provider, path);
  const result = await tool(glyph, provider, 'propose_edits', { files: [structured(path, base.revision, content)] });
  expect(result.status).toBe('APPLIED_WITH_REVERT');
  await expect(pending(glyph)).toBeVisible();
  return result;
}
/** @param {GlyphWorkbench} glyph */
async function openFile(glyph, path = 'review.txt') {
  await glyph.page.keyboard.press('ControlOrMeta+p');
  await glyph.page.locator('.quick-input-widget input').fill(join(glyph.workspace, path));
  await expect(glyph.page.locator('.quick-input-list').getByRole('option').first()).toContainText(basename(path));
  await glyph.page.keyboard.press('Enter');
  await expect(glyph.page.locator('.editor-instance .monaco-editor:not(.gutter):visible').first()).toBeVisible();
}
/** @param {GlyphWorkbench} glyph */
async function save(glyph, path = 'review.txt') {
  await openFile(glyph, path);
  await glyph.page.keyboard.press('ControlOrMeta+s');
}
/**
 * @param {GlyphWorkbench} glyph
 * @param {string} text
 */
async function setText(glyph, text) {
  await openFile(glyph);
  await glyph.page.keyboard.press('ControlOrMeta+a');
  await glyph.page.keyboard.insertText(text);
  await glyph.command('Focus Glyph');
}

it.describe('Text proposal review', () => {
  it.describe.configure({ mode: 'default' });
  it.use({
    sharedLaunch: true,
    scriptedProvider: true,
    workspaceFiles: { 'review.txt': original, 'other.ts': 'const value = 1;\n' },
  });

  it('applies and saves a strict patch before review while retaining its original diff', async ({
    glyph,
    provider,
  }) => {
    const base = await read(glyph, provider);
    const patch = [
      '*** Begin Patch',
      '*** Update File: review.txt',
      `*** Revision: ${base.revision}`,
      '@@',
      '-one',
      '+ONE',
      ' unchanged',
      ' three',
      '*** End Patch',
    ].join('\n');
    const result = await tool(glyph, provider, 'propose_patch', patch, 'text');
    expect(result.status).toBe('APPLIED_WITH_REVERT');
    await expect(pending(glyph)).toContainText('review.txt');
    await pending(glyph).getByRole('button', { name: 'Review', exact: true }).click();
    await expect(controls(glyph)).toBeVisible();
    await expect(glyph.page.locator('.monaco-diff-editor .view-lines')).toContainText(['one', 'ONE']);
    expect(await readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe('ONE\nunchanged\nthree\n');
    await save(glyph);
    expect(await readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe('ONE\nunchanged\nthree\n');
  });

  it('keeps applied edits without a second write and supports ordinary editor Undo', async ({ glyph, provider }) => {
    await stage(glyph, provider, 'ONE\nunchanged\nthree\n');
    await pending(glyph).getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(pending(glyph)).toHaveCount(0);
    expect(await readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe('ONE\nunchanged\nthree\n');
    await save(glyph);
    await expect.poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe('ONE\nunchanged\nthree\n');
    await glyph.page.keyboard.press('ControlOrMeta+z');
    await glyph.page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe(original);
  });

  it('reverts applied changes in both the editor and disk', async ({ glyph, provider }) => {
    await stage(glyph, provider);
    await pending(glyph).getByRole('button', { name: 'Revert', exact: true }).click();
    await expect(pending(glyph)).toHaveCount(0);
    await save(glyph);
    expect(await readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe(original);
  });

  it('refuses a revert after the user overwrites the applied content', async ({ glyph, provider }) => {
    await stage(glyph, provider);
    await setText(glyph, 'User-owned replacement\n');
    await pending(glyph).getByRole('button', { name: 'Revert', exact: true }).click();
    await expect(pending(glyph).getByRole('alert')).toBeVisible();
    await save(glyph);
    await expect.poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe('User-owned replacement\n');
  });
  it('reviews patch items individually and delivers accepted and rejected receipts to the agent', async ({
    glyph,
    provider,
  }, testInfo) => {
    const base = await read(glyph, provider);
    const patch = [
      '*** Begin Patch',
      '*** Update File: review.txt',
      `*** Revision: ${base.revision}`,
      '@@',
      '-one',
      '+ONE',
      ' unchanged',
      '-three',
      '+THREE',
      '*** End Patch',
    ].join('\n');
    expect((await tool(glyph, provider, 'propose_patch', patch, 'text')).review_items).toBe(2);
    await pending(glyph).getByRole('button', { name: 'Review', exact: true }).click();
    await expect(controls(glyph)).toContainText('1 of 2');
    await glyph.page.screenshot({ path: testInfo.outputPath('native-review.png') });
    await controls(glyph).getByRole('button', { name: 'Next change', exact: true }).click();
    await expect(controls(glyph)).toContainText('2 of 2');
    await controls(glyph).getByRole('button', { name: 'Previous change', exact: true }).click();
    await controls(glyph).getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(controls(glyph)).toContainText('1 of 1');
    await controls(glyph).getByRole('button', { name: 'Revert', exact: true }).click();
    await expect(pending(glyph)).toHaveCount(0);
    await save(glyph);
    await expect.poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe('ONE\nunchanged\nthree\n');
    const count = provider.requests.length;
    provider.enqueue({ chunks: ['Review received.'] });
    await glyph.send('Continue after review.');
    await expect.poll(() => provider.requests.length).toBe(count + 1);
    const receipts = provider.requests
      .at(-1)
      .body.input.filter(item => item.role === 'developer')
      .flatMap(item => {
        try {
          const value = contextEventMessage.safeParse(parseJson(typeof item.content === 'string' ? item.content : ''));
          return value.success && value.data.event.type === 'edit_review_result' ? [value.data.event] : [];
        } catch {
          return [];
        }
      });
    expect(receipts.flatMap(event => (event.payload?.items ?? []).map(entry => entry.decision)).toSorted()).toEqual([
      'ACCEPTED',
      'REJECTED',
    ]);
  });

  it('uses scoped review shortcuts and sends a rejection comment in the agent receipt', async ({
    glyph,
    provider,
  }, testInfo) => {
    await stage(glyph, provider);
    await pending(glyph).getByRole('button', { name: 'Review', exact: true }).click();
    const keep = controls(glyph).getByRole('button', { name: 'Keep', exact: true });
    const undo = controls(glyph).getByRole('button', { name: 'Revert', exact: true });
    const comment = controls(glyph).getByRole('button', { name: 'Reject with comments', exact: true });
    const modifier = process.platform === 'darwin' ? '⌘' : 'Ctrl+';
    await expect(keep).toContainText(`${modifier}Y`);
    await expect(undo).toContainText(`${modifier}N`);
    await expect(comment).toContainText(`${modifier}R`);
    expect(await keep.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(
      await comment.evaluate(node => getComputedStyle(node).backgroundColor),
    );
    await keep.focus();
    await glyph.page.keyboard.press('ControlOrMeta+y');
    await expect(controls(glyph)).toContainText('1 of 1');
    await glyph.page.locator('.monaco-diff-editor .editor.modified').getByRole('textbox').first().focus();
    await glyph.page.keyboard.press('ControlOrMeta+r');
    const form = glyph.page.getByRole('form', { name: 'Rejection comment' });
    await expect(form).toBeVisible();
    const input = form.getByRole('textbox');
    await expect(input).toBeFocused();
    await expect(form.getByRole('button', { name: 'Reject with comment', exact: true })).toBeDisabled();
    await input.fill('Keep the final line unchanged; it is a public contract.');
    // Editing the comment must not trigger review decisions.
    await glyph.page.keyboard.press('ControlOrMeta+y');
    await expect(pending(glyph)).toBeVisible();
    await glyph.page.screenshot({ path: testInfo.outputPath('review-comment.png') });
    await form.getByRole('button', { name: 'Reject with comment', exact: true }).click();
    await expect(pending(glyph)).toHaveCount(0);
    const annotations = glyph.page.locator('.glyph-composer .glyph-annotation-pill');
    await expect(annotations).toContainText('1 annotation');
    await annotations.getByRole('button', { name: '1 annotation', exact: true }).focus();
    const editAnnotation = annotations.getByRole('button', { name: 'Edit annotation 1', exact: true });
    await editAnnotation.focus();
    await editAnnotation.press('Enter');
    const annotationInput = glyph.page.getByRole('textbox', { name: 'Annotation comment' });
    await expect(annotationInput).toHaveValue('Keep the final line unchanged; it is a public contract.');
    await annotationInput.press('Enter');
    await save(glyph);
    await expect.poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe('ONE\nunchanged\nthree\n');
    const count = provider.requests.length;
    provider.enqueue({ chunks: ['Feedback received.'] });
    await glyph.send('Continue after review.');
    await expect.poll(() => provider.requests.length).toBe(count + 1);
    const receipts = provider.requests
      .at(-1)
      .body.input.filter(item => item.role === 'developer')
      .flatMap(item => {
        try {
          const value = contextEventMessage.safeParse(parseJson(typeof item.content === 'string' ? item.content : ''));
          return value.success && value.data.event.type === 'edit_review_result'
            ? (value.data.event.payload?.items ?? [])
            : [];
        } catch {
          return [];
        }
      });
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: 'REJECTED',
          rejectionComment: 'Keep the final line unchanged; it is a public contract.',
        }),
      ]),
    );
    // The Revert shortcut restores the content from before the latest applied edit.
    await stage(glyph, provider, 'ONE\nunchanged\nLAST\n');
    await pending(glyph).getByRole('button', { name: 'Review', exact: true }).click();
    await controls(glyph).getByRole('button', { name: 'Revert', exact: true }).focus();
    await glyph.page.keyboard.press('ControlOrMeta+n');
    await expect(pending(glyph)).toHaveCount(0);
  });

  it('annotates a selected proposal passage without making a review decision and reopens its numbered comment', async ({
    glyph,
    provider,
  }) => {
    await stage(glyph, provider);
    await pending(glyph).getByRole('button', { name: 'Review', exact: true }).click();
    await expect(controls(glyph)).toBeVisible();
    const editor = glyph.page.locator('.monaco-diff-editor .editor.modified').getByRole('textbox').first();
    await editor.focus();
    await glyph.page.keyboard.press('ControlOrMeta+a');
    await expect(glyph.page.getByRole('button', { name: 'Comment on selection', exact: true })).toContainText(
      'Add to Chat',
    );
    await expect(
      glyph.page.getByRole('button', { name: 'Comment on selection', exact: true }).locator('kbd'),
    ).toContainText('L');
    await glyph.page.keyboard.press('ControlOrMeta+l');
    const input = glyph.page.getByRole('textbox', { name: 'Annotation comment' });
    await expect(input).toBeVisible();
    const expectCodeBelowPrompt = async () => {
      await expect
        .poll(
          async () => {
            const popup = await glyph.page.getByRole('form', { name: 'Annotation editor' }).boundingBox();
            const deletedLine = await glyph.page
              .locator('.monaco-diff-editor .editor.modified .view-line')
              .evaluateAll(lines => {
                return lines
                  .filter(line => line.textContent.trim() === 'one')
                  .map(line => line.getBoundingClientRect())
                  .find(rect => rect.width > 0 && rect.height > 0)?.top;
              });
            return deletedLine === undefined ? -Infinity : deletedLine - popup.y - popup.height;
          },
          { message: 'The deleted line must remain fully below the annotation prompt' },
        )
        .toBeGreaterThanOrEqual(4);
    };
    await expectCodeBelowPrompt();
    const popupBounds = await glyph.page.getByRole('form', { name: 'Annotation editor' }).boundingBox();
    const editorBounds = await glyph.page.locator('.monaco-diff-editor .editor.modified').boundingBox();
    expect(popupBounds.x).toBeGreaterThanOrEqual(editorBounds.x);
    expect(popupBounds.x + popupBounds.width).toBeLessThanOrEqual(editorBounds.x + editorBounds.width);
    await input.fill('Explain these changes first.');
    await expectCodeBelowPrompt();
    await input.press('Enter');
    await expect(pending(glyph)).toBeVisible();
    expect(await readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe(changed);
    const marker = glyph.page.locator('.monaco-diff-editor').getByRole('button', { name: 'Edit annotation 1' });
    await expect(marker).toBeVisible();
    await expect(marker.locator('xpath=ancestor::*[contains(@class, "glyph-margin-widgets")]')).toHaveCount(1);
    await marker.click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Explain these changes first.');
    await expectCodeBelowPrompt();
    await input.fill(
      'Explain these changes first.\nKeep the original behavior.\nPreserve the public contract.\nCheck the final line.',
    );
    await expectCodeBelowPrompt();
    const originalSize = await glyph.application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const size = window.getContentSize();
      window.setContentSize(1100, size[1]);
      return size;
    });
    await expect.poll(() => glyph.page.evaluate(() => innerWidth)).toBe(1100);
    await expectCodeBelowPrompt();
    await glyph.application.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]);
    }, originalSize);
    await expect.poll(() => glyph.page.evaluate(() => innerWidth)).toBe(originalSize[0]);
    await expectCodeBelowPrompt();
    await input.fill('Keep the original behavior.');
    await expectCodeBelowPrompt();
    await input.press('Enter');
    provider.enqueue({ chunks: ['I will revise the proposal.'] });
    await glyph.send('Revise using this feedback.');
    await expect(glyph.page.locator('.glyph-transcript')).toContainText('I will revise the proposal.');
    await expect(marker).toHaveCount(0);
    await expect(glyph.page.getByRole('form', { name: 'Annotation editor' })).toHaveCount(0);
    await expect(glyph.page.getByRole('button', { name: 'Comment on selection', exact: true })).toHaveCount(0);
    const prompt = JSON.stringify(provider.requests.at(-1).body.input);
    expect(prompt).toContain('Keep the original behavior.');
    expect(prompt).toContain('proposal');
  });

  it('rejects malformed patches and stale revisions without partial staging or application', async ({
    glyph,
    provider,
  }) => {
    const invalid = await tool(glyph, provider, 'propose_patch', '*** Begin Patch\nnot a patch\n*** End Patch', 'text');
    expect(invalid.error).toBeTruthy();
    const stale = [
      '*** Begin Patch',
      '*** Update File: review.txt',
      '*** Revision: stale-revision',
      '@@',
      '-one',
      '+ONE',
      '*** End Patch',
    ].join('\n');
    expect((await tool(glyph, provider, 'propose_patch', stale, 'text')).error.code).toBe('STALE');
    await expect(pending(glyph)).toHaveCount(0);
    await save(glyph);
    expect(await readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe(original);
  });

  it('preserves Unicode, whitespace and CRLF when applying structured UTF-16 range edits', async ({
    glyph,
    provider,
  }) => {
    const text = '  café 🌱\r\n\tsecond\r\n';
    await setText(glyph, text);
    // A text model uses the document EOL. First make the requested CRLF explicit.
    await stage(glyph, provider, text);
    await pending(glyph).getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(pending(glyph)).toHaveCount(0);
    const base = await read(glyph, provider);
    const edits = [
      {
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 9 } },
        expected_text: '🌱',
        replacement_text: '🌳',
      },
    ];
    expect(
      (await tool(glyph, provider, 'propose_edits', { files: [structured('review.txt', base.revision, null, edits)] }))
        .status,
    ).toBe('APPLIED_WITH_REVERT');
    await pending(glyph).getByRole('button', { name: 'Review', exact: true }).click();
    await expect(glyph.page.locator('.monaco-diff-editor')).toContainText('🌳');
    await pending(glyph).getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(pending(glyph)).toHaveCount(0);
    await save(glyph);
    await expect.poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe('  café 🌳\r\n\tsecond\r\n');
  });

  it('applies explicit LF/CRLF conversions through an undoable editor EOL operation', async ({ glyph, provider }) => {
    await stage(glyph, provider, original.replaceAll('\n', '\r\n'));
    await pending(glyph).getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(pending(glyph)).toHaveCount(0);
    await save(glyph);
    await expect
      .poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8'))
      .toBe(original.replaceAll('\n', '\r\n'));
    await glyph.page.keyboard.press('ControlOrMeta+z');
    await glyph.page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe(original);
    // A conversion combined with changed text must also restore exact original bytes.
    await stage(glyph, provider, original.toUpperCase().replaceAll('\n', '\r\n'));
    await pending(glyph).getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(pending(glyph)).toHaveCount(0);
    await save(glyph);
    await expect
      .poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8'))
      .toBe(original.toUpperCase().replaceAll('\n', '\r\n'));
    await glyph.page.keyboard.press('ControlOrMeta+z');
    await glyph.page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe(original);
  });

  it('refuses invalid ranges and proposals compiled against an older editor revision', async ({ glyph, provider }) => {
    const base = await read(glyph, provider);
    const edits = [
      {
        range: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } },
        expected_text: 'x',
        replacement_text: 'y',
      },
    ];
    expect(
      (await tool(glyph, provider, 'propose_edits', { files: [structured('review.txt', base.revision, null, edits)] }))
        .error,
    ).toBeTruthy();
    await setText(glyph, 'New buffer\n');
    expect(
      (await tool(glyph, provider, 'propose_edits', { files: [structured('review.txt', base.revision, changed)] }))
        .error.code,
    ).toBe('STALE');
    await expect(pending(glyph)).toHaveCount(0);
    await save(glyph);
    await expect.poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe('New buffer\n');
  });

  it(
    'restores pending reviews after reload, exposes file actions on focus, and navigates multiple files',
    reloadsWindow,
    async ({ glyph, provider }, testInfo) => {
      const first = await read(glyph, provider);
      const second = await read(glyph, provider, 'other.ts');
      expect(
        (
          await tool(glyph, provider, 'propose_edits', {
            files: [
              structured('review.txt', first.revision, changed),
              structured('other.ts', second.revision, 'const value = 2;\n'),
            ],
          })
        ).status,
      ).toBe('APPLIED_WITH_REVERT');
      await glyph.reload();
      await expect(pending(glyph)).toContainText('2 Files');
      const file = pending(glyph).getByRole('button', { name: 'Review review.txt', exact: true });
      await file.focus();
      await expect(file).toHaveAttribute('title', 'review.txt');
      await expect(pending(glyph).getByRole('button', { name: 'Keep review.txt', exact: true })).toHaveCSS(
        'opacity',
        '1',
      );
      await glyph.page.screenshot({ path: testInfo.outputPath('pending-hover.png') });
      await file.click();
      await expect(fileControls(glyph)).toContainText('1 of 2 Files');
      await fileControls(glyph).getByRole('button', { name: 'Review Next File' }).click();
      await expect(fileControls(glyph)).toContainText('2 of 2 Files');
      await fileControls(glyph).getByRole('button', { name: 'Revert File', exact: true }).click();
      await expect(pending(glyph)).toContainText('1 File');
      await pending(glyph).getByRole('button', { name: 'Keep', exact: true }).click();
      await expect(pending(glyph)).toHaveCount(0);
      await save(glyph);
      await expect.poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe(changed);
      expect(await readFile(join(glyph.workspace, 'other.ts'), 'utf8')).toBe('const value = 1;\n');
    },
  );
  it('keeps all files through the bulk review action', async ({ glyph, provider }) => {
    const first = await read(glyph, provider);
    const second = await read(glyph, provider, 'other.ts');
    await tool(glyph, provider, 'propose_edits', {
      files: [
        structured('review.txt', first.revision, changed),
        structured('other.ts', second.revision, 'const value = 2;\n'),
      ],
    });
    await pending(glyph).getByRole('button', { name: 'Keep All', exact: true }).click();
    await expect(pending(glyph)).toHaveCount(0);
    await save(glyph);
    await expect.poll(() => readFile(join(glyph.workspace, 'review.txt'), 'utf8')).toBe(changed);
    await save(glyph, 'other.ts');
    await expect.poll(() => readFile(join(glyph.workspace, 'other.ts'), 'utf8')).toBe('const value = 2;\n');
  });
});
