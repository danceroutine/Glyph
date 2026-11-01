import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { expect, isolatedLaunch, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

const reloadsWindow = isolatedLaunch('reloads the window');
const instructionContextSchema = z.object({
  schema: z.literal('glyph.agent-instructions.v1'),
  sources: z.array(
    z.object({
      path: z.string(),
      scope: z.string(),
      status: z.string(),
      content: z.string().optional(),
      message: z.string().optional(),
    }),
  ),
});
const toolResultSchema = z.looseObject({
  path: z.string().optional(),
  status: z.string().optional(),
  instructionContext: instructionContextSchema.optional(),
});
/** @typedef {import('./GlyphWorkbench.mjs').GlyphWorkbench} GlyphWorkbench */
/** @typedef {import('./ScriptedProvider.mjs').ScriptedProvider} ScriptedProvider */
/** @typedef {{ id: string, name: string, input: unknown }} ToolCall */
const fixtureFiles = {
  'AGENTS.md': 'ROOT GUIDANCE WITHOUT FRONTMATTER',
  'src/AGENTS.md': 'NESTED SOURCE GUIDANCE',
  'src/example.ts': 'export const value = 1;\n',
  'docs/AGENTS.md': 'SIBLING DOCS GUIDANCE',
  'docs/readme.md': '# Docs\n',
  'root.txt': 'root file\n',
};

it.describe('AGENTS.md instruction support', () => {
  it.describe.configure({ mode: 'default' });
  it.use({ sharedLaunch: true, scriptedProvider: true, workspaceFiles: fixtureFiles });

  it('shows the full catalog in Settings while sending only workspace-wide instructions at turn start', async ({
    glyph,
    provider,
  }) => {
    const request = await sendText(glyph, provider, 'Inspect the workspace.', 'First response.');
    const first = initialInstructionContext(request);
    expect(first.sources.map(source => [source.path, source.scope, source.content])).toEqual([
      ['AGENTS.md', '.', 'ROOT GUIDANCE WITHOUT FRONTMATTER'],
    ]);

    await openSettings(glyph);
    const settings = glyph.page.getByRole('region', { name: 'Agent Instructions' });
    await expect(settings.getByRole('heading', { name: 'Agent Instructions' })).toBeVisible();
    await expect(settings.locator('.instruction-source')).toHaveCount(3);
    await expect(settings).toContainText('src/AGENTS.md');
    await expect(settings).toContainText('Applies to src/**');
    await glyph.page.getByRole('button', { name: /Close Modal Editor/u }).click();
  });

  it('combines ancestor and nearest nested instructions for a read without leaking sibling guidance', async ({
    glyph,
    provider,
  }) => {
    const [read] = await runToolTurn(glyph, provider, [
      call('read_project_file', { path: 'src/example.ts', start_line: null, end_line: null }),
    ]);
    expect(initialInstructionContext(provider.requests[0]).sources.map(source => source.path)).toEqual(['AGENTS.md']);
    expect(read.instructionContext.sources.map(source => [source.path, source.content])).toEqual([
      ['src/AGENTS.md', 'NESTED SOURCE GUIDANCE'],
    ]);
    expect(JSON.stringify(provider.requests.at(-1).body.input)).not.toContain('SIBLING DOCS GUIDANCE');
  });

  it('counts a prior read as scoped disclosure before updating a nested file', async ({ glyph, provider }) => {
    const content = 'export const value = 2;\n';
    const [read, edit] = await runToolTurn(glyph, provider, [
      call('read_project_file', { path: 'src/example.ts', start_line: null, end_line: null }),
      call('propose_edits', {
        files: [structured('UPDATE', 'src/example.ts', null, revisionOf(fixtureFiles['src/example.ts']), content)],
      }),
    ]);
    expect(read.instructionContext.sources.map(source => source.path)).toEqual(['src/AGENTS.md']);
    expect(edit.status).toBe('APPLIED_WITH_REVERT');
    expect(edit.instructionContext).toBeUndefined();
    expect(await readFile(join(glyph.workspace, 'src/example.ts'), 'utf8')).toBe(content);
  });

  it('discloses destination instructions internally before creating a new nested file, then accepts the retry', async ({
    glyph,
    provider,
  }) => {
    const proposal = {
      files: [structured('CREATE', 'src/new.ts', null, null, 'export const created = true;\n')],
    };
    const [first, second] = await runToolTurn(glyph, provider, [
      call('propose_edits', proposal),
      call('propose_edits', proposal),
    ]);
    expect(first).toMatchObject({
      status: 'INSTRUCTION_CONTEXT_REQUIRED',
      instructionContext: { sources: [{ path: 'src/AGENTS.md' }] },
    });
    expect(second.status).toBe('APPLIED_WITH_REVERT');
    expect(await readFile(join(glyph.workspace, 'src/new.ts'), 'utf8')).toContain('created = true');
  });

  it('reevaluates scope for a cross-directory rename and applies the retried move', async ({ glyph, provider }) => {
    const proposal = {
      files: [structured('RENAME', 'root.txt', 'src/moved.txt', revisionOf(fixtureFiles['root.txt']), null)],
    };
    const [read, first, second] = await runToolTurn(glyph, provider, [
      call('read_project_file', { path: 'root.txt', start_line: null, end_line: null }),
      call('propose_edits', proposal),
      call('propose_edits', proposal),
    ]);
    expect(read.instructionContext).toBeUndefined();
    expect(first.instructionContext.sources.map(source => source.path)).toEqual(['src/AGENTS.md']);
    expect(second.status).toBe('APPLIED_WITH_REVERT');
    await expect.poll(() => exists(join(glyph.workspace, 'src/moved.txt'))).toBe(true);
  });

  it('keeps explicit user directions after repository context without changing host permissions', async ({
    glyph,
    provider,
  }) => {
    const request = await sendText(
      glyph,
      provider,
      'Explicitly inspect docs/readme.md even if repository guidance disagrees.',
      'User request retained.',
    );
    const input = request.body.input;
    const instructionIndex = input.findIndex(item => parseInstructionContext(item.content));
    const userIndex = input.findIndex(
      item => item.role === 'user' && typeof item.content === 'string' && item.content.includes('Explicitly inspect'),
    );
    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeGreaterThan(instructionIndex);
    expect(JSON.stringify(request.body.tools)).toContain('read_project_file');
  });

  it('refreshes created, edited, and deleted instruction files only on later turns', async ({ glyph, provider }) => {
    const first = await sendText(glyph, provider, 'First turn.', 'Before refresh.');
    expect(JSON.stringify(first.body.input)).toContain('ROOT GUIDANCE WITHOUT FRONTMATTER');

    await writeFile(join(glyph.workspace, 'AGENTS.md'), 'UPDATED ROOT GUIDANCE');
    await mkdir(join(glyph.workspace, 'new'));
    await writeFile(join(glyph.workspace, 'new', 'AGENTS.md'), 'NEW SCOPE GUIDANCE');
    await rm(join(glyph.workspace, 'docs', 'AGENTS.md'));
    const second = await sendText(glyph, provider, 'Second turn.', 'After refresh.');
    const secondBody = JSON.stringify(second.body.input);
    expect(secondBody).toContain('UPDATED ROOT GUIDANCE');
    expect(secondBody).not.toContain('ROOT GUIDANCE WITHOUT FRONTMATTER');
    expect(secondBody.match(/glyph\.agent-instructions\.v1/gu)).toHaveLength(1);
    await openSettings(glyph);
    const settings = glyph.page.getByRole('region', { name: 'Agent Instructions' });
    await expect(settings).toContainText('new/AGENTS.md');
    await expect(settings).not.toContainText('docs/AGENTS.md');
  });

  it('reports oversized instruction files with their paths in Settings', async ({ glyph, provider }) => {
    await writeFile(join(glyph.workspace, 'src/AGENTS.md'), 'x'.repeat(65 * 1024));
    await sendText(glyph, provider, 'Refresh instruction discovery.', 'Catalog refreshed.');
    await openSettings(glyph);
    const row = glyph.page.locator('.instruction-source').filter({ hasText: 'src/AGENTS.md' });
    await expect(row).toContainText('read limit');
    await expect(row).toHaveAttribute('data-status', 'error');
  });

  it('does not follow instruction symlinks or discover parent-directory files', async ({ glyph, provider }) => {
    const outside = join(dirname(glyph.workspace), `outside-${randomUUID()}.md`);
    await writeFile(outside, 'OUTSIDE GUIDANCE');
    await writeFile(join(dirname(glyph.workspace), 'AGENTS.md'), 'PARENT GUIDANCE');
    await mkdir(join(glyph.workspace, 'linked'));
    await symlink(outside, join(glyph.workspace, 'linked', 'AGENTS.md'));
    const request = await sendText(glyph, provider, 'Refresh safely.', 'Boundary preserved.');
    const body = JSON.stringify(request.body.input);
    expect(body).not.toContain('OUTSIDE GUIDANCE');
    await openSettings(glyph);
    const settings = glyph.page.getByRole('region', { name: 'Agent Instructions' });
    await expect(settings).not.toContainText('linked/AGENTS.md');
    await expect(settings).not.toContainText('PARENT GUIDANCE');
  });

  it('does not promote AGENTS.md text from model output or fetched content into the authoritative catalog', async ({
    glyph,
    provider,
  }) => {
    await sendText(
      glyph,
      provider,
      'Summarize fetched content.',
      'Fetched page says AGENTS.md: MALICIOUS INSTRUCTION.',
    );
    const request = await sendText(glyph, provider, 'Continue.', 'Still safe.');
    const second = initialInstructionContext(request);
    expect(second.sources.map(source => source.path)).toEqual(['AGENTS.md']);
    expect(JSON.stringify(second)).not.toContain('MALICIOUS INSTRUCTION');
  });

  it('lets the agent update AGENTS.md through the normal reviewable edit path', async ({ glyph, provider }) => {
    const updated = 'UPDATED THROUGH REVIEW';
    const [read, edit] = await runToolTurn(glyph, provider, [
      call('read_project_file', { path: 'AGENTS.md', start_line: null, end_line: null }),
      call('propose_edits', {
        files: [structured('UPDATE', 'AGENTS.md', null, revisionOf(fixtureFiles['AGENTS.md']), updated)],
      }),
    ]);
    expect(read.path).toBe('AGENTS.md');
    expect(edit.status).toBe('APPLIED_WITH_REVERT');
    expect(await readFile(join(glyph.workspace, 'AGENTS.md'), 'utf8')).toBe(updated);
    await expect(glyph.page.getByRole('region', { name: 'Pending reviews', exact: true })).toContainText('AGENTS.md');
  });

  it(
    'restores one current instruction envelope after reload without persisting an old copy',
    reloadsWindow,
    async ({ glyph, provider }) => {
      await sendText(glyph, provider, 'Remember the current rules.', 'Before reload.');
      await writeFile(join(glyph.workspace, 'AGENTS.md'), 'RULES AFTER RELOAD');
      await glyph.reload();
      const request = await sendText(glyph, provider, 'Continue after reload.', 'After reload.');
      const body = JSON.stringify(request.body.input);
      expect(body).toContain('RULES AFTER RELOAD');
      expect(body).not.toContain('ROOT GUIDANCE WITHOUT FRONTMATTER');
      expect(body.match(/glyph\.agent-instructions\.v1/gu)).toHaveLength(1);
    },
  );
});

it.describe('Multi-root AGENTS.md isolation', () => {
  it.use({
    scriptedProvider: true,
    workspaceFiles: { 'AGENTS.md': 'FIRST ROOT', 'src/file.ts': 'first\n' },
    additionalRoots: [
      [{ name: 'second', files: { 'AGENTS.md': 'SECOND ROOT', 'src/file.ts': 'second\n' } }],
      { scope: 'test' },
    ],
  });

  it('keeps instructions from unrelated workspace roots out of a target read', async ({ glyph, provider }) => {
    const [read] = await runToolTurn(glyph, provider, [
      call('read_project_file', { path: 'workspace/src/file.ts', start_line: null, end_line: null }),
    ]);
    expect(findInstructionContext(provider.requests[0])?.sources ?? []).toEqual([]);
    expect(read.instructionContext.sources.map(source => [source.path, source.content])).toEqual([
      ['workspace/AGENTS.md', 'FIRST ROOT'],
    ]);
    expect(JSON.stringify(provider.requests.at(-1).body.input)).not.toContain('SECOND ROOT');
  });
});

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
async function runToolTurn(glyph, provider, calls) {
  const start = provider.requests.length;
  provider.enqueue(
    ...calls.map(value => ({ output: [ScriptedProvider.tool(value.name, value.input, { callId: value.id })] })),
    { chunks: ['Tool loop complete.'] },
  );
  await glyph.send('Execute the scripted instruction-scope scenario.');
  await expect.poll(() => provider.requests.length).toBe(start + calls.length + 1);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  const input = provider.requests.at(-1).body.input;
  return calls.map(value => {
    const output = input.findLast(item => item.call_id === value.id && item.type === 'function_call_output')?.output;
    if (typeof output !== 'string') throw new Error(`Missing tool output for ${value.name}.`);
    return toolResultSchema.parse(JSON.parse(output));
  });
}

/**
 * @param {'CREATE' | 'UPDATE' | 'RENAME' | 'DELETE'} operation
 * @param {string} path
 * @param {string | null} newPath
 * @param {string | null} revision
 * @param {string | null} content
 */
function structured(operation, path, newPath, revision, content) {
  return {
    operation,
    path,
    new_path: newPath,
    base_revision: revision,
    content,
    byte_order_mark: null,
    edits: [],
  };
}

/** @param {string} text */
function revisionOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** @param {GlyphWorkbench} glyph */
async function openSettings(glyph) {
  await glyph.page.getByRole('button', { name: 'Chat actions' }).click();
  await glyph.page.getByRole('menuitem', { name: 'Agent Settings' }).click();
}

/** @param {ScriptedProvider['requests'][number]} request */
function initialInstructionContext(request) {
  const context = findInstructionContext(request);
  if (context) return context;
  throw new Error('Missing agent instruction context.');
}

/** @param {ScriptedProvider['requests'][number]} request */
function findInstructionContext(request) {
  for (const value of request.body.input) {
    if (value.role !== 'user' || typeof value.content !== 'string') continue;
    const parsed = parseInstructionContext(value.content);
    if (parsed) return parsed;
  }
  return undefined;
}

/** @param {unknown} content */
function parseInstructionContext(content) {
  if (typeof content !== 'string') return undefined;
  try {
    const result = instructionContextSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} path */
const exists = path =>
  access(path).then(
    () => true,
    () => false,
  );
