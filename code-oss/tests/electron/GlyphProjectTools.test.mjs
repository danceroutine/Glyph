import { randomUUID } from 'node:crypto';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

it.describe('Pending file references in agent messages', () => {
  it.fixme('opens a workspace file link at its requested one-based line', async () => {
    // Stream [file.ts:42](src/file.ts#L42), click the rendered link, and verify
    // the native editor opens that file with line 42 revealed and the caret there.
  });
  it.fixme('opens a workspace file link with its requested line range selected', async () => {
    // Stream [file.ts:42-50](src/file.ts#L42-L50), click the rendered link, and
    // verify lines 42 through 50 are selected and revealed in the native editor.
  });
  it.fixme('instructs the agent to cite inspected workspace files using clickable file and line links', async () => {
    // Inspect the outgoing provider instructions for the supported Markdown
    // format: workspace-relative paths, #L42 for a line, and #L42-L50 for a range.
    // Require file references to use this format and only cite verified locations.
    // Scripted responses can verify rendering/navigation, not model compliance.
  });
});

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
  const requestCount = provider.requests.length;
  provider.enqueue(
    { output: calls.map(([name, args], index) => ScriptedProvider.tool(name, args, { callId: ids[index] })) },
    { chunks: [answer] },
  );
  await glyph.send('Inspect these workspace files.');
  await expect.poll(() => provider.requests.length).toBe(requestCount + 2);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  await expect(glyph.assistantEntries.last().locator('[data-glyph-source]')).toHaveText(answer);
  const input = provider.requests.at(-1).body.input;
  return ids.map(id => {
    const outputs = input.filter(item => item.type === 'function_call_output' && item.call_id === id);
    expect(outputs).toHaveLength(1);
    return JSON.parse(outputs[0].output);
  });
}

async function openFile(glyph, path) {
  await glyph.page.keyboard.press('ControlOrMeta+p');
  const input = glyph.page.locator('.quick-input-widget input');
  await input.fill(path);
  await glyph.page.keyboard.press('Enter');
  await expect(glyph.page.locator('.editor-instance .monaco-editor').first()).toBeVisible();
}

async function editFile(glyph, path, text) {
  await openFile(glyph, path);
  await glyph.page.keyboard.press('ControlOrMeta+a');
  await glyph.page.keyboard.insertText(text);
  await expect(glyph.page.locator('.tab.dirty').first()).toBeVisible();
  await glyph.command('Focus Glyph');
}

it.describe('Project file discovery and reads', () => {
  it.describe.configure({ mode: 'default' });
  it.use({
    sharedLaunch: true,
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

  it('paginates mixed saved and unsaved matches consistently across filters and output modes', async ({
    glyph,
    provider,
  }) => {
    await editFile(glyph, join(glyph.workspace, 'src/alpha.ts'), 'before\nNeedle live\nneedle lower\nafter');
    await editFile(glyph, join(glyph.workspace, 'docs/alpha.md'), 'Needle live documentation');
    const options = { path: 'src', file_glob: '*.ts', file_type: 'ts', case_sensitive: false, limit: 1 };
    const [first, second, third, exhausted, exact, regex, multiline, counts, files] = await runTools(glyph, provider, [
      search('needle', options),
      search('needle', { ...options, offset: 1 }),
      search('needle', { ...options, offset: 2 }),
      search('needle', { ...options, offset: 3 }),
      search('Needle', { ...options, case_sensitive: true, limit: 10 }),
      search('N[a-z]+ live', { ...options, pattern_kind: 'regular_expression' }),
      search('live\\nneedle', { ...options, pattern_kind: 'regular_expression', multiline: true }),
      search('needle', { ...options, output_mode: 'count', limit: 10 }),
      search('needle', { ...options, output_mode: 'files_with_matches', offset: 1 }),
    ]);
    expect(first).toMatchObject({ matches: [{ path: 'src/alpha.ts', line: 2 }], truncated: true, nextOffset: 1 });
    expect(second).toMatchObject({ matches: [{ path: 'src/alpha.ts', line: 3 }], truncated: true, nextOffset: 2 });
    expect(third).toMatchObject({ matches: [{ path: 'src/beta.ts', line: 1 }], truncated: false, nextOffset: null });
    expect(exhausted).toMatchObject({ matches: [], truncated: false, nextOffset: null });
    expect(exact.matches.map(match => [match.path, match.line])).toEqual([
      ['src/alpha.ts', 2],
      ['src/beta.ts', 1],
    ]);
    expect(regex.matches).toMatchObject([{ path: 'src/alpha.ts', line: 2, matchedText: 'Needle live' }]);
    expect(multiline.matches).toMatchObject([
      { path: 'src/alpha.ts', line: 2, endLine: 3, matchedText: 'live\nneedle' },
    ]);
    expect(counts.counts).toEqual([
      { path: 'src/alpha.ts', count: 2 },
      { path: 'src/beta.ts', count: 1 },
    ]);
    expect(files).toMatchObject({ files: ['src/beta.ts'], truncated: false, nextOffset: null });
    expect(await readFile(join(glyph.workspace, 'src/alpha.ts'), 'utf8')).toContain('Needle café');
    expect(await readFile(join(glyph.workspace, 'docs/alpha.md'), 'utf8')).toBe('Needle documentation\n');
  });

  it('refreshes search after edits, save, and revert without resurrecting obsolete matches', async ({
    glyph,
    provider,
  }) => {
    const path = join(glyph.workspace, 'src/alpha.ts');
    await editFile(glyph, path, 'Needle first edit');
    const [first] = await runTools(glyph, provider, [search('Needle', { path: 'src/alpha.ts' })]);
    expect(first.matches.map(match => match.lineText)).toEqual(['Needle first edit']);

    await editFile(glyph, path, 'Needle second edit');
    const [second, obsolete] = await runTools(glyph, provider, [
      search('Needle', { path: 'src/alpha.ts' }),
      search('first edit'),
    ]);
    expect(second.matches.map(match => match.lineText)).toEqual(['Needle second edit']);
    expect(obsolete.matches).toEqual([]);
    await openFile(glyph, path);
    await glyph.page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readFile(path, 'utf8')).toBe('Needle second edit');
    await expect(glyph.page.locator('.tab.dirty')).toHaveCount(0);
    await glyph.command('Focus Glyph');
    const [saved] = await runTools(glyph, provider, [search('Needle', { path: 'src/alpha.ts' })]);
    expect(saved.matches).toEqual(second.matches);

    await editFile(glyph, path, 'No matching text remains');
    const [empty] = await runTools(glyph, provider, [search('Needle', { path: 'src/alpha.ts' })]);
    expect(empty).toMatchObject({ matches: [], truncated: false });
    await openFile(glyph, path);
    await glyph.command('File: Revert File');
    await expect(glyph.page.locator('.tab.dirty')).toHaveCount(0);
    await glyph.command('Focus Glyph');
    const [reverted] = await runTools(glyph, provider, [search('Needle', { path: 'src/alpha.ts' })]);
    expect(reverted.matches).toEqual(second.matches);
    expect(await readFile(path, 'utf8')).toBe('Needle second edit');
  });
});

it.describe('Bounded editor search', () => {
  it.describe.configure({ mode: 'default' });
  it.use({
    sharedLaunch: true,
    scriptedProvider: true,
    workspaceFiles: {
      'large.txt': 'Needle disk\n' + ('x'.repeat(99) + '\n').repeat(5200),
      'one.txt': 'Needle one\n' + ('x'.repeat(99) + '\n').repeat(4000),
      'two.txt': 'Needle two\n' + ('x'.repeat(99) + '\n').repeat(4000),
    },
  });

  it('reports oversized editor snapshots instead of silently searching stale disk text and recovers after revert', async ({
    glyph,
    provider,
  }) => {
    const path = join(glyph.workspace, 'large.txt');
    await openFile(glyph, path);
    await glyph.page.keyboard.press('ControlOrMeta+End');
    await glyph.page.keyboard.insertText(('y'.repeat(99) + '\n').repeat(100));
    await expect(glyph.page.locator('.tab.dirty')).toHaveCount(1);
    await glyph.command('Focus Glyph');
    const [oversized] = await runTools(glyph, provider, [search('Needle', { path: 'large.txt' })]);
    expect(oversized.error).toMatchObject({ message: expect.stringMatching(/large\.txt.*512 KiB/) });
    expect(oversized.matches).toBeUndefined();
    expect(await readFile(path, 'utf8')).not.toContain('y');
    await openFile(glyph, path);
    await glyph.command('File: Revert File');
    await expect(glyph.page.locator('.tab.dirty')).toHaveCount(0);
    await glyph.command('Focus Glyph');
    const [recovered] = await runTools(glyph, provider, [search('Needle', { path: 'large.txt' })]);
    expect(recovered.matches).toMatchObject([{ path: 'large.txt', line: 1, matchedText: 'Needle' }]);
  });

  it('reports aggregate snapshot overflow without partial search results and recovers when buffers shrink', async ({
    glyph,
    provider,
  }) => {
    for (const file of ['one.txt', 'two.txt']) {
      await openFile(glyph, join(glyph.workspace, file));
      await glyph.page.keyboard.press('ControlOrMeta+End');
      await glyph.page.keyboard.insertText('unsaved');
    }
    await expect(glyph.page.locator('.tab.dirty')).toHaveCount(2);
    await glyph.command('Focus Glyph');
    const [overflow] = await runTools(glyph, provider, [search('Needle')]);
    expect(overflow.error).toMatchObject({ message: expect.stringContaining('aggregate byte budget') });
    expect(overflow.matches).toBeUndefined();
    for (const file of ['one.txt', 'two.txt']) {
      await editFile(glyph, join(glyph.workspace, file), 'Needle live');
      expect(await readFile(join(glyph.workspace, file), 'utf8')).not.toContain('unsaved');
    }
    const [recovered] = await runTools(glyph, provider, [search('Needle live')]);
    expect(recovered.matches.map(match => match.path)).toEqual(['one.txt', 'two.txt']);
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
  it.describe.configure({ mode: 'default' });
  it.use({
    sharedLaunch: true,
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

  it('keeps dirty same-named files isolated across root filters and paginated search results', async ({
    glyph,
    provider,
  }) => {
    await editFile(glyph, join(glyph.rootPaths[0], 'shared.txt'), 'live first root');
    await editFile(glyph, join(glyph.rootPaths[1], 'shared.txt'), 'live second root');
    const [first, second, scoped, globbed, stale] = await runTools(glyph, provider, [
      search('live', { limit: 1 }),
      search('live', { limit: 1, offset: 1 }),
      search('live', { path: 'second/shared.txt' }),
      search('live', { file_glob: 'workspace/*.txt' }),
      search('root marker'),
    ]);
    const combined = [...first.matches, ...second.matches].map(match => [match.path, match.lineText]).sort();
    expect(combined).toEqual([
      ['second/shared.txt', 'live second root'],
      ['workspace/shared.txt', 'live first root'],
    ]);
    expect(first).toMatchObject({ truncated: true, nextOffset: 1 });
    expect(second).toMatchObject({ truncated: false, nextOffset: null });
    expect(scoped.matches.map(match => match.path)).toEqual(['second/shared.txt']);
    expect(globbed.matches.map(match => match.path)).toEqual(['workspace/shared.txt']);
    expect(stale.matches).toEqual([]);
    expect(await readFile(join(glyph.rootPaths[0], 'shared.txt'), 'utf8')).toBe('First root marker');
    expect(await readFile(join(glyph.rootPaths[1], 'shared.txt'), 'utf8')).toBe('Second root marker');
  });
});
