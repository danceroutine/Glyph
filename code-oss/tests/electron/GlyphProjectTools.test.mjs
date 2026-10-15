import { randomUUID } from 'node:crypto';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

const list = (glob_pattern = '**/*', target_directory = null) => [
  'list_project_files',
  { glob_pattern, target_directory },
];
const read = (path, start_line = null, end_line = null) => ['read_project_file', { path, start_line, end_line }];
const search = (pattern, options = {}) => [
  'search_project_contents',
  {
    pattern,
    pattern_kind: 'literal',
    path: null,
    file_glob: null,
    file_type: null,
    output_mode: 'content',
    lines_before: 0,
    lines_after: 0,
    case_sensitive: true,
    multiline: false,
    limit: 100,
    offset: 0,
    ...options,
  },
];

async function runTools(glyph, provider, calls, answer = 'The requested project tools finished.') {
  const ids = calls.map(() => randomUUID());
  provider.enqueue(
    { output: calls.map(([name, args], index) => ScriptedProvider.tool(name, args, { callId: ids[index] })) },
    { chunks: [answer] },
  );
  await glyph.send('Inspect these workspace files.');
  await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
  await expect(glyph.assistantEntries.last().locator('div')).toHaveText(answer);
  const input = provider.requests.at(-1).body.input;
  return ids.map(id => {
    const outputs = input.filter(item => item.type === 'function_call_output' && item.call_id === id);
    expect(outputs).toHaveLength(1);
    return JSON.parse(outputs[0].output);
  });
}

async function editFile(glyph, path, text) {
  await glyph.page.keyboard.press('ControlOrMeta+p');
  const input = glyph.page.locator('.quick-input-widget input');
  await input.fill(path);
  await glyph.page.keyboard.press('Enter');
  await expect(glyph.page.locator('.editor-instance .monaco-editor').first()).toBeVisible();
  await glyph.page.keyboard.press('ControlOrMeta+a');
  await glyph.page.keyboard.insertText(text);
  await expect(glyph.page.locator('.tab.dirty').first()).toBeVisible();
  await glyph.command('Focus Glyph');
}

it.describe('Project file discovery and reads', () => {
  it.use({
    scriptedProvider: true,
    workspaceFiles: {
      'src/alpha.ts': 'before\nNeedle café 🌱\nafter\nneedle lowercase\n',
      'src/beta.ts': 'Needle beta\n',
      'docs/alpha.md': 'Needle documentation\n',
      '.env': 'SECRET_SENTINEL',
      '.gitignore': 'ignored.txt\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
      'ignored.txt': 'SECRET_SENTINEL',
      'node_modules/private.txt': 'SECRET_SENTINEL',
    },
  });

  it('returns matching workspace file paths for a glob and directory filter and lets the agent cite those paths', async ({
    glyph,
    provider,
  }) => {
    const [result] = await runTools(glyph, provider, [list('*.ts', 'src')], 'Found src/alpha.ts and src/beta.ts.');
    expect(result).toEqual({ files: ['src/alpha.ts', 'src/beta.ts'], truncated: false });
  });

  it('excludes ignored and sensitive files and refuses paths or symlinks outside the authorized workspace', async ({
    glyph,
    provider,
  }) => {
    const outside = join(glyph.workspace, '..', 'outside.txt');
    await writeFile(outside, 'OUTSIDE_SENTINEL');
    await symlink(outside, join(glyph.workspace, 'escape.txt'));
    const results = await runTools(glyph, provider, [
      list(),
      list('**/*', '../'),
      read('escape.txt'),
      read('../outside.txt'),
    ]);
    for (const excluded of ['.env', 'ignored.txt', 'node_modules/private.txt', 'escape.txt'])
      expect(results[0].files).not.toContain(excluded);
    for (const result of results.slice(1)) expect(result.error).toBeDefined();
    expect(JSON.stringify(results)).not.toContain('OUTSIDE_SENTINEL');
    expect(JSON.stringify(results)).not.toContain('SECRET_SENTINEL');
  });

  it('returns the requested file or line range and lets the agent identify the source path and lines', async ({
    glyph,
    provider,
  }) => {
    const [whole, range] = await runTools(
      glyph,
      provider,
      [read('src/alpha.ts'), read('src/alpha.ts', 2, 3)],
      'src/alpha.ts:2 contains Needle café 🌱; line 3 contains after.',
    );
    expect(whole.lines.map(line => line.content)).toEqual([
      'before',
      'Needle café 🌱',
      'after',
      'needle lowercase',
      '',
    ]);
    expect(range).toMatchObject({
      path: 'src/alpha.ts',
      startLine: 2,
      endLine: 3,
      lines: [
        { number: 2, content: 'Needle café 🌱' },
        { number: 3, content: 'after' },
      ],
    });
  });

  it('reads unsaved editor text instead of stale disk content without saving the document', async ({
    glyph,
    provider,
  }) => {
    const dirty = `Unsaved ${randomUUID()} café 🌱`;
    await editFile(glyph, join(glyph.workspace, 'src/alpha.ts'), dirty);
    const [result] = await runTools(glyph, provider, [read('src/alpha.ts')]);
    expect(result.lines).toEqual([{ number: 1, content: dirty, lineEnding: '' }]);
    expect(await readFile(join(glyph.workspace, 'src/alpha.ts'), 'utf8')).toContain('Needle café');
    await expect(glyph.page.locator('.tab.dirty')).toHaveCount(1);
  });

  it('reports a missing or denied file without exposing other files or fabricating file contents', async ({
    glyph,
    provider,
  }) => {
    const results = await runTools(glyph, provider, [
      read('missing.txt'),
      read('.env'),
      read('node_modules/private.txt'),
    ]);
    for (const result of results) {
      expect(result.error).toBeDefined();
      expect(result.content).toBeUndefined();
    }
    expect(JSON.stringify(results)).not.toContain('SECRET_SENTINEL');
    const [valid] = await runTools(glyph, provider, [read('src/beta.ts')]);
    expect(valid.lines[0].content).toBe('Needle beta');
  });

  it('finds literal and regular-expression matches with source paths, line numbers, and requested context', async ({
    glyph,
    provider,
  }) => {
    const [literal, regex] = await runTools(
      glyph,
      provider,
      [
        search('Needle café', { lines_before: 1, lines_after: 1 }),
        search('N[a-z]+ café', { pattern_kind: 'regular_expression', file_type: 'ts' }),
      ],
      'The match is in src/alpha.ts on line 2.',
    );
    expect(literal.matches).toEqual([
      expect.objectContaining({
        path: 'src/alpha.ts',
        line: 2,
        column: 1,
        matchedText: 'Needle café',
        linesBefore: [{ number: 1, content: 'before' }],
        linesAfter: [{ number: 3, content: 'after' }],
      }),
    ]);
    expect(regex.matches).toEqual([
      expect.objectContaining({ path: 'src/alpha.ts', line: 2, matchedText: 'Needle café' }),
    ]);
  });

  it('honors case sensitivity, path filters, and result limits and distinguishes no matches from truncation', async ({
    glyph,
    provider,
  }) => {
    const [first, next, none, exact] = await runTools(glyph, provider, [
      search('needle', { case_sensitive: false, path: 'src', file_glob: '*.ts', limit: 1 }),
      search('needle', { case_sensitive: false, path: 'src', file_glob: '*.ts', limit: 1, offset: 1 }),
      search('no-such-marker'),
      search('needle', { path: 'src/alpha.ts' }),
    ]);
    expect(first).toMatchObject({ truncated: true, nextOffset: 1, matches: [{ path: 'src/alpha.ts', line: 2 }] });
    expect(next.matches).toMatchObject([{ path: 'src/alpha.ts', line: 4 }]);
    expect(none).toMatchObject({ matches: [], truncated: false, nextOffset: null });
    expect(exact.matches).toMatchObject([{ path: 'src/alpha.ts', line: 4 }]);
  });

  it('searches unsaved editor text and suppresses stale disk matches for that same file', async ({
    glyph,
    provider,
  }) => {
    const marker = `Live-${randomUUID()}`;
    const spelling = process.platform === 'darwin' ? 'SRC/ALPHA.TS' : 'src/alpha.ts';
    await editFile(glyph, join(glyph.workspace, spelling), `before\n${marker}\nafter`);
    const [live, stale, count, files, snapshot] = await runTools(glyph, provider, [
      search(marker, { lines_before: 1, lines_after: 1 }),
      search('Needle', { path: 'src/alpha.ts' }),
      search(marker, { output_mode: 'count' }),
      search(marker, { output_mode: 'files_with_matches' }),
      read('src/alpha.ts'),
    ]);
    expect(live.matches).toMatchObject([
      {
        path: 'src/alpha.ts',
        line: 2,
        matchedText: marker,
        linesBefore: [{ number: 1, content: 'before' }],
        linesAfter: [{ number: 3, content: 'after' }],
      },
    ]);
    expect(stale).toMatchObject({ matches: [], truncated: false });
    expect(count.counts).toEqual([{ path: 'src/alpha.ts', count: 1 }]);
    expect(files.files).toEqual(['src/alpha.ts']);
    expect(snapshot.lines[1].content).toBe(marker);
    expect(await readFile(join(glyph.workspace, 'src/alpha.ts'), 'utf8')).not.toContain(marker);
    // An open sensitive file must not become searchable through the editor path.
    await editFile(glyph, join(glyph.workspace, '.env'), `SECRET_SENTINEL ${marker}`);
    const [excluded] = await runTools(glyph, provider, [search('SECRET_SENTINEL')]);
    expect(excluded.matches).toEqual([]);
  });

  it('reports an invalid search expression without ending the chat or exposing excluded files', async ({
    glyph,
    provider,
  }) => {
    const [invalid] = await runTools(glyph, provider, [search('[', { pattern_kind: 'regular_expression' })]);
    expect(invalid.error).toMatchObject({ code: 'MALFORMED' });
    const [valid, excluded] = await runTools(glyph, provider, [search('Needle'), search('SECRET_SENTINEL')]);
    expect(valid.matches).toHaveLength(3);
    expect(excluded.matches).toEqual([]);
  });
});

it.describe('Bounded file listing', () => {
  it.use({
    scriptedProvider: true,
    workspaceFiles: Object.fromEntries(
      Array.from({ length: 2001 }, (_, i) => [`many/file-${String(i).padStart(4, '0')}.txt`, 'bounded']),
    ),
  });
  it('distinguishes an empty match set from a truncated list when the result limit is reached', async ({
    glyph,
    provider,
  }) => {
    const [empty, full] = await runTools(glyph, provider, [list('*.missing'), list('*.txt', 'many')]);
    expect(empty).toEqual({ files: [], truncated: false });
    expect(full.files).toHaveLength(2000);
    expect(full.truncated).toBe(true);
  });
});

it.describe('Multi-root file discovery', () => {
  it.use({
    scriptedProvider: true,
    workspaceFiles: { 'shared.txt': 'First root marker' },
    additionalRoots: [[{ name: 'second', files: { 'shared.txt': 'Second root marker' } }], { scope: 'test' }],
  });
  it('qualifies matching paths by workspace root when two roots contain the same relative filename', async ({
    glyph,
    provider,
  }) => {
    const [listed, first, second] = await runTools(glyph, provider, [
      list('shared.txt'),
      read('workspace/shared.txt'),
      read('second/shared.txt'),
    ]);
    expect(listed.files.sort()).toEqual(['second/shared.txt', 'workspace/shared.txt']);
    expect(first.lines[0].content).toBe('First root marker');
    expect(second.lines[0].content).toBe('Second root marker');
    await editFile(glyph, join(glyph.rootPaths[1], 'shared.txt'), 'Second root unsaved');
    const [found, stale] = await runTools(glyph, provider, [search('root'), search('Second root marker')]);
    expect(found.matches.map(match => [match.path, match.lineText]).sort()).toEqual([
      ['second/shared.txt', 'Second root unsaved'],
      ['workspace/shared.txt', 'First root marker'],
    ]);
    expect(stale.matches).toEqual([]);
    expect(await readFile(join(glyph.rootPaths[1], 'shared.txt'), 'utf8')).toBe('Second root marker');
  });
});
