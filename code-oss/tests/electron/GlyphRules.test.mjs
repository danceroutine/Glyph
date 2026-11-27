import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { expect, isolatedLaunch, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

const contextSchema = z.looseObject({
  schema: z.literal('glyph.agent-instructions.v1'),
  sources: z.array(z.looseObject({ id: z.string(), path: z.string(), content: z.string().optional() })),
  candidates: z.array(z.looseObject({ id: z.string(), name: z.string() })).optional(),
  policy: z.string().optional(),
});
const toolResultSchema = z.looseObject({
  status: z.string().optional(),
  instructionContext: contextSchema.optional(),
});
/** @typedef {import('./GlyphWorkbench.mjs').GlyphWorkbench} GlyphWorkbench */
/** @typedef {import('./ScriptedProvider.mjs').ScriptedProvider} ScriptedProvider */
/** @typedef {{ id: string, name: string, input: unknown }} ToolCall */
const files = {
  '.glyph/rules/always.mdc': '---\nname: Always Rule\nalwaysApply: true\n---\nALWAYS BODY',
  '.glyph/rules/typescript.mdc': '---\nname: TypeScript Rule\nglobs: ["**/*.ts"]\n---\nTYPESCRIPT BODY',
  '.glyph/rules/model.mdc': '---\nname: Model Rule\ndescription: API design\n---\nMODEL BODY',
  '.glyph/rules/manual.mdc': '---\nname: Manual Rule\nactivation: manual\n---\nMANUAL BODY',
  '.cursor/rules/compat.mdc': '---\nglobs: ["**/*.md"]\n---\nCURSOR BODY',
  'src/app.ts': 'export const app = true;\n',
  'notes.txt': 'plain\n',
};

it.describe('agent rules', () => {
  it.describe.configure({ mode: 'default' });
  it.use({
    sharedLaunch: true,
    scriptedProvider: true,
    workspaceFiles: files,
    userSettings: { 'files.autoSave': 'off' },
  });

  it('includes always-on rules, advertises model rules, and identifies used sources in the inspector', async ({
    glyph,
    provider,
  }) => {
    const request = await sendText(glyph, provider, 'Inspect this project.', 'Done.');
    const context = initialContext(request);
    expect(context.sources.map(source => source.path)).toContain('.glyph/rules/always.mdc');
    expect((context.candidates ?? []).map(candidate => candidate.name)).toContain('Model Rule');
    const answer = glyph.assistantEntries.last();
    await expect(answer.getByText(/Context used/u)).toBeVisible();
    await answer.getByText(/Context used/u).click();
    await expect(answer).toContainText('Always Rule');
  });

  it('activates matching path rules once, ignores nonmatches, and reevaluates the next turn', async ({
    glyph,
    provider,
  }) => {
    const [first, second, plain] = await runTools(glyph, provider, [
      call('read_project_file', { path: 'src/app.ts', start_line: null, end_line: null }),
      call('read_project_file', { path: 'src/app.ts', start_line: null, end_line: null }),
      call('read_project_file', { path: 'notes.txt', start_line: null, end_line: null }),
    ]);
    expect(first.instructionContext.sources.map(source => source.path)).toContain('.glyph/rules/typescript.mdc');
    expect(second.instructionContext).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain('TYPESCRIPT BODY');
    const next = await sendText(glyph, provider, 'New turn.', 'Fresh.');
    expect(JSON.stringify(initialContext(next))).not.toContain('TYPESCRIPT BODY');
  });

  it(
    'blocks only operations under an unreadable nested AGENTS.md',
    isolatedLaunch('exercises unreadable nested guidance'),
    async ({ glyph, provider }) => {
      await mkdir(join(glyph.workspace, 'private-scope'));
      await writeFile(join(glyph.workspace, 'private-scope/AGENTS.md'), 'G'.repeat(65537));
      await writeFile(join(glyph.workspace, 'private-scope/source.txt'), 'Protected content');
      await glyph.reload();
      const [read, edit, other] = await runTools(glyph, provider, [
        call('read_project_file', { path: 'private-scope/source.txt', start_line: null, end_line: null }),
        call('propose_edits', { files: [structured('CREATE', 'private-scope/new.txt', null, null, 'new')] }),
        call('read_project_file', { path: 'notes.txt', start_line: null, end_line: null }),
      ]);
      for (const result of [read, edit])
        expect(result).toMatchObject({ error: { message: expect.stringContaining('private-scope/AGENTS.md') } });
      expect(JSON.stringify(read)).not.toContain('Protected content');
      expect(JSON.stringify(other)).toContain('plain');
      await expect(readFile(join(glyph.workspace, 'private-scope/new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('lets the model activate a description-selected rule through the bounded rule tool', async ({
    glyph,
    provider,
  }) => {
    const start = provider.requests.length;
    provider.enqueue(
      {
        output: [
          ScriptedProvider.tool(
            'activate_rule',
            { id: 'glyph_project_rule:.glyph/rules/model.mdc' },
            {
              namespace: 'context',
            },
          ),
        ],
      },
      { chunks: ['Selected.'] },
    );
    await glyph.send('Design an API.');
    await expect.poll(() => provider.requests.length).toBe(start + 2);
    const output = provider.requests.at(-1)?.body.input.findLast(item => item.type === 'function_call_output')?.output;
    if (typeof output !== 'string') throw new Error('The rule activation tool did not return output.');
    expect(toolResultSchema.parse(JSON.parse(output)).instructionContext?.sources[0]?.content).toBe('MODEL BODY');
  });

  it(
    'preserves a selected manual rule through a new-chat draft reload',
    isolatedLaunch('reloads a new-chat draft'),
    async ({ glyph, provider }) => {
      await glyph.composer.fill('Use /Man');
      await glyph.page.getByRole('option', { name: /Manual Rule/u }).click();
      await glyph.reload();
      provider.enqueue({ chunks: ['Applied.'] });
      await glyph.sendButton.click();
      await expect.poll(() => provider.requests.length).toBe(1);
      expect(JSON.stringify(provider.requests[0].body.input)).toContain('MANUAL BODY');
    },
  );

  it('applies a manual rule only after the user selects its context badge', async ({ glyph, provider }) => {
    const skipped = await sendText(glyph, provider, 'No manual rule.', 'Skipped.');
    expect(JSON.stringify(skipped.body.input)).not.toContain('MANUAL BODY');
    await glyph.composer.fill('Use /Man');
    await glyph.page.getByRole('option', { name: /Manual Rule/u }).click();
    const start = provider.requests.length;
    provider.enqueue({ chunks: ['Applied.'] });
    await glyph.sendButton.click();
    await expect.poll(() => provider.requests.length).toBe(start + 1);
    expect(JSON.stringify(provider.requests[start].body.input)).toContain('MANUAL BODY');
  });

  it('shows native and Cursor rules, activation metadata, and invalid-source errors in Settings', async ({
    glyph,
    provider,
  }) => {
    await writeFile(join(glyph.workspace, '.glyph/rules/bad.mdc'), '---\nglobs: [../bad]\n---\nBAD');
    await sendText(glyph, provider, 'Refresh rules.', 'Ready.');
    await openSettings(glyph);
    const settings = glyph.page.getByRole('region', { name: 'Agent Instructions' });
    await expect(settings).toContainText('Always Rule');
    await expect(settings).toContainText('Cursor-compatible rule');
    await expect(settings).toContainText('Matching files');
    await expect(settings).toContainText('Invalid rule glob');
  });

  it(
    'creates, previews, disables, and removes user rules with an explicit activation mode',
    isolatedLaunch('mutates user rules'),
    async ({ glyph, provider }) => {
      await sendText(glyph, provider, 'Open rule settings.', 'Ready.');
      await openSettings(glyph);
      const settings = glyph.page.getByRole('region', { name: 'Agent Instructions' });
      const name = `Electron Rule ${randomUUID().slice(0, 8)}`;
      await settings.getByRole('textbox', { name: 'New user rule name' }).fill(name);
      await settings.getByRole('combobox', { name: 'Rule activation' }).selectOption('model');
      await settings.getByRole('textbox', { name: 'When should the model use this rule?' }).fill('Review the sample.');
      await settings.getByRole('button', { name: 'Create' }).click();
      const row = settings.locator('.instruction-source').filter({ hasText: name });
      await expect(row).toBeVisible();
      await row.getByText('Preview').click();
      await expect(row).toContainText('Describe the rule here.');
      await row.getByRole('button', { name: 'Disable' }).click();
      await expect(row).toContainText('Disabled');
      await row.getByRole('button', { name: 'Remove' }).click();
      await expect(row).toHaveCount(0);
    },
  );

  it('lets agents create project rules through review and refreshes only later turns', async ({ glyph, provider }) => {
    const text = '---\nname: Proposed\nactivation: manual\n---\nPROPOSED BODY';
    const [edit] = await runTools(glyph, provider, [
      call('propose_edits', { files: [structured('CREATE', '.glyph/rules/proposed.mdc', null, null, text)] }),
    ]);
    expect(edit.status).toBe('APPLIED_WITH_REVERT');
    expect(await readFile(join(glyph.workspace, '.glyph/rules/proposed.mdc'), 'utf8')).toBe(text);
    await openSettings(glyph);
    await expect(glyph.page.getByRole('region', { name: 'Agent Instructions' })).toContainText('Proposed');
  });

  for (const [storedName, editorName, action] of [
    ['café.mdc', 'cafe\u0301.mdc', 'Disable'],
    ['ß.mdc', 'SS.mdc', 'Remove'],
    ['ı.mdc', 'i.mdc', 'Disable'],
  ]) {
    it(
      `checks the dirty native editor before Settings can ${action.toLowerCase()} ${storedName}`,
      isolatedLaunch('opens a dirty user rule'),
      async ({ glyph, session }) => {
        const directory = join(session.sandbox, 'glyph-user', 'rules');
        const { sameFile, stored, alternate } = await openDirtyRule(glyph, directory, storedName, editorName);
        await openSettings(glyph);
        const settings = glyph.page.getByRole('region', { name: 'Agent Instructions' });
        const row = settings.locator('.instruction-source').filter({ hasText: 'Stored guidance' });
        await row.getByRole('button', { name: action, exact: true }).click();
        if (sameFile) {
          await expect(
            glyph.page
              .getByRole('alert')
              .filter({ hasText: /save or discard unsaved changes/iu })
              .first(),
          ).toBeVisible();
          await expect(row.getByRole('button', { name: action, exact: true })).toBeVisible();
          expect(await readFile(stored, 'utf8')).toBe(storedRule);
        } else {
          if (action === 'Remove') {
            await expect(row).toHaveCount(0);
            await expect(readFile(stored)).rejects.toMatchObject({ code: 'ENOENT' });
          } else {
            await expect(row.getByRole('button', { name: 'Enable' })).toBeVisible();
            expect(await readFile(stored, 'utf8')).toContain('enabled: false');
          }
          expect(await readFile(alternate, 'utf8')).toBe(siblingRule);
        }
        await expect(glyph.page.locator('.part.editor .tab.dirty')).toHaveCount(1);
      },
    );
  }

  for (const [storedName, editorName] of [
    ['café.mdc', 'cafe\u0301.mdc'],
    ['ı.mdc', 'i.mdc'],
  ]) {
    it(
      `sends the live project rule from a dirty native editor opened as ${editorName}`,
      isolatedLaunch('opens a dirty project rule'),
      async ({ glyph, provider }) => {
        const directory = join(glyph.workspace, '.glyph', 'rules');
        const { sameFile, stored, alternate } = await openDirtyRule(glyph, directory, storedName, editorName);
        const request = await sendText(glyph, provider, 'Read the current project guidance.', 'Done.');
        const contents = initialContext(request).sources.map(source => source.content);
        expect(contents.filter(content => content === 'DIRTY RULE BODY')).toHaveLength(1);
        expect(contents.filter(content => content === 'STORED RULE BODY')).toHaveLength(sameFile ? 0 : 1);
        expect(contents).not.toContain('SIBLING RULE BODY');
        expect(await readFile(stored, 'utf8')).toBe(storedRule);
        expect(await readFile(alternate, 'utf8')).toBe(sameFile ? storedRule : siblingRule);
        await expect(glyph.page.locator('.part.editor .tab.dirty')).toHaveCount(1);
      },
    );
  }

  it(
    'freezes in-flight revisions, reloads without duplicates, and keeps rules below user and host authority',
    isolatedLaunch('reloads rule state'),
    async ({ glyph, provider }) => {
      const first = await sendText(glyph, provider, 'Do not modify files.', 'Understood.');
      expect(initialContext(first).policy).toContain(
        'within the tools, permissions and workspace access granted by host and user policy',
      );
      await writeFile(join(glyph.workspace, '.glyph/rules/always.mdc'), '---\nalwaysApply: true\n---\nUPDATED BODY');
      await glyph.reload();
      const next = await sendText(glyph, provider, 'After reload.', 'Done.');
      const context = initialContext(next);
      expect(JSON.stringify(context)).toContain('UPDATED BODY');
      expect(context.sources.filter(source => source.path === '.glyph/rules/always.mdc')).toHaveLength(1);
    },
  );

  // Rank 22 owns compaction itself; the persisted context snapshot is already versioned for replay.
  it.fixme('retains always-on guidance and reevaluates conditional guidance after context compaction', async () => {});
});

const storedRule = '---\nname: Stored guidance\nalwaysApply: true\n---\nSTORED RULE BODY';
const siblingRule = '---\nname: Sibling guidance\nalwaysApply: true\n---\nSIBLING RULE BODY';

/** @param {GlyphWorkbench} glyph @param {string} directory @param {string} storedName @param {string} editorName */
async function openDirtyRule(glyph, directory, storedName, editorName) {
  await mkdir(directory, { recursive: true });
  const stored = join(directory, storedName);
  const alternate = join(directory, editorName);
  await writeFile(stored, storedRule, { flag: 'wx' });
  if (!existsSync(alternate)) await writeFile(alternate, siblingRule, { flag: 'wx' });
  const [savedEntry, editorEntry] = await Promise.all([
    stat(stored, { bigint: true }),
    stat(alternate, { bigint: true }),
  ]);
  const sameFile = savedEntry.dev === editorEntry.dev && savedEntry.ino === editorEntry.ino;
  await glyph.reload();
  const { page } = glyph;
  await page.keyboard.press('ControlOrMeta+p');
  await page.locator('.quick-input-widget input').fill(alternate);
  await expect(page.locator('.quick-input-list').getByRole('option').first()).toContainText(editorName);
  await page.keyboard.press('Enter');
  await expect(page.locator('.quick-input-widget')).not.toBeVisible();
  const editor = page.locator('.editor-instance .monaco-editor[data-uri]').last();
  const lines = editor.locator('.view-lines');
  await expect(lines).toContainText(sameFile ? 'STORED RULE BODY' : 'SIBLING RULE BODY');
  expect(basename(fileURLToPath((await editor.getAttribute('data-uri')) ?? ''))).toBe(editorName);
  await lines.click({ position: { x: 4, y: 3 } });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('---\nname: Dirty guidance\nalwaysApply: true\n---\nDIRTY RULE BODY');
  await expect(lines).toContainText('DIRTY RULE BODY');
  await expect(page.locator('.part.editor .tab.dirty')).toHaveCount(1);
  return { sameFile, stored, alternate };
}

/** @param {string} name @param {unknown} input @returns {ToolCall} */
function call(name, input) {
  return { id: randomUUID(), name, input };
}
/**
 * @param {GlyphWorkbench} glyph
 * @param {ScriptedProvider} provider
 * @param {string} prompt
 * @param {string} response
 */
async function sendText(glyph, provider, prompt, response) {
  const start = provider.requests.length;
  provider.enqueue({ chunks: [response] });
  await glyph.send(prompt);
  await expect.poll(() => provider.requests.length).toBe(start + 1);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  const request = provider.requests[start];
  if (!request) throw new Error('The scripted provider did not receive the turn.');
  return request;
}
/** @param {GlyphWorkbench} glyph @param {ScriptedProvider} provider @param {ToolCall[]} calls */
async function runTools(glyph, provider, calls) {
  const start = provider.requests.length;
  provider.enqueue(
    ...calls.map(value => ({ output: [ScriptedProvider.tool(value.name, value.input, { callId: value.id })] })),
    { chunks: ['Done.'] },
  );
  await glyph.send('Execute the scripted rule scenario.');
  await expect.poll(() => provider.requests.length).toBe(start + calls.length + 1);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  const input = provider.requests.at(-1)?.body.input ?? [];
  return calls.map(value => {
    const output = input.findLast(item => item.call_id === value.id && item.type === 'function_call_output')?.output;
    if (typeof output !== 'string') throw new Error(`Missing tool output for ${value.name}.`);
    return toolResultSchema.parse(JSON.parse(output));
  });
}
/** @param {ScriptedProvider['requests'][number]} request */
function initialContext(request) {
  for (const item of request.body.input) {
    const context = parseContext(item.content);
    if (context) return context;
  }
  throw new Error('Missing rule instruction context.');
}
/** @param {unknown} content */
function parseContext(content) {
  if (typeof content !== 'string') return undefined;
  try {
    const value = contextSchema.safeParse(JSON.parse(content));
    return value.success ? value.data : undefined;
  } catch {
    return undefined;
  }
}
/** @param {GlyphWorkbench} glyph */
async function openSettings(glyph) {
  await glyph.page.getByRole('button', { name: 'Chat actions' }).click();
  await glyph.page.getByRole('menuitem', { name: 'Agent Settings' }).click();
}
/**
 * @param {'CREATE' | 'UPDATE' | 'RENAME' | 'DELETE'} operation
 * @param {string} path
 * @param {string | null} newPath
 * @param {string | null} revision
 * @param {string | null} content
 */
function structured(operation, path, newPath, revision, content) {
  return { operation, path, new_path: newPath, base_revision: revision, content, byte_order_mark: null, edits: [] };
}
