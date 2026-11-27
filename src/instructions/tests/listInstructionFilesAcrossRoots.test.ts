import { describe, expect, it, vi } from 'vitest';
import { listInstructionFilesAcrossRoots } from '#src/instructions/listInstructionFilesAcrossRoots.js';

describe(listInstructionFilesAcrossRoots, () => {
  it('reserves root guidance before nested files even when the count allowance is exhausted', async () => {
    const first = { glob: vi.fn(async () => ({ files: ['AGENTS.md'], truncated: false })) };
    const second = { glob: vi.fn(async () => ({ files: ['agents.MD'], truncated: false })) };
    const roots = [
      { name: 'one', index: first },
      { name: 'two', index: second },
    ];
    await expect(listInstructionFilesAcrossRoots(roots, 1, '**/AGENTS.md')).resolves.toEqual({
      files: ['one/AGENTS.md', 'two/agents.MD'],
      truncated: true,
    });
    for (const root of roots)
      expect(root.index.glob).toHaveBeenCalledExactlyOnceWith('AGENTS.md', { limit: 1, rootFilesOnly: true });
  });

  it('preserves single-root paths and provider truncation', async () => {
    const index = {
      glob: vi
        .fn()
        .mockResolvedValueOnce({ files: ['AGENTS.md'], truncated: false })
        .mockResolvedValueOnce({ files: ['src/AGENTS.md'], truncated: true }),
    };
    await expect(listInstructionFilesAcrossRoots([{ name: 'one', index }], 2, '**/AGENTS.md')).resolves.toEqual({
      files: ['AGENTS.md', 'src/AGENTS.md'],
      truncated: true,
    });
    expect(index.glob).toHaveBeenLastCalledWith('**/?*/AGENTS.md', { limit: 1 });
  });

  it('queries every root with the remaining budget and qualifies colliding paths', async () => {
    const first = { glob: vi.fn(async () => ({ files: ['.glyph/rules/style.mdc'], truncated: false })) };
    const second = { glob: vi.fn(async () => ({ files: ['.glyph/rules/style.mdc'], truncated: false })) };
    await expect(
      listInstructionFilesAcrossRoots(
        [
          { name: 'one', index: first },
          { name: 'two', index: second },
        ],
        3,
        '**/.glyph/rules/*.mdc',
      ),
    ).resolves.toEqual({ files: ['one/.glyph/rules/style.mdc', 'two/.glyph/rules/style.mdc'], truncated: false });
    expect(first.glob).toHaveBeenCalledExactlyOnceWith('**/.glyph/rules/*.mdc', { limit: 3 });
    expect(second.glob).toHaveBeenCalledExactlyOnceWith('**/.glyph/rules/*.mdc', { limit: 2 });
  });

  it('returns no files for no roots or no budget', async () => {
    await expect(listInstructionFilesAcrossRoots([], 10, '**/AGENTS.md')).resolves.toEqual({
      files: [],
      truncated: false,
    });
    const index = { glob: vi.fn() };
    await expect(
      listInstructionFilesAcrossRoots([{ name: 'one', index }], 0, '**/.glyph/rules/*.mdc'),
    ).resolves.toEqual({
      files: [],
      truncated: true,
    });
    expect(index.glob).not.toHaveBeenCalled();
  });

  it('reports required lookup failures per root and retains healthy roots', async () => {
    const glob = vi
      .fn()
      .mockResolvedValueOnce({ files: ['AGENTS.md'], truncated: false })
      .mockResolvedValueOnce({ files: ['nested/AGENTS.md'], truncated: false });
    const roots = [
      { name: 'healthy', index: { glob } },
      { name: 'broken', index: { glob: vi.fn().mockRejectedValue(new Error('Unavailable')) } },
      { name: 'unknown', index: { glob: vi.fn().mockRejectedValue('failed') } },
      { name: 'incomplete', index: { glob: vi.fn().mockResolvedValue({ files: [], truncated: true }) } },
      {
        name: 'nested',
        index: { glob: vi.fn().mockResolvedValueOnce({ files: [], truncated: false }).mockRejectedValue('failed') },
      },
      {
        name: 'other',
        index: {
          glob: vi
            .fn()
            .mockResolvedValueOnce({ files: [], truncated: false })
            .mockRejectedValue(new Error('Nested unavailable')),
        },
      },
    ];
    expect(await listInstructionFilesAcrossRoots(roots, 10, '**/AGENTS.md')).toEqual({
      files: ['healthy/AGENTS.md', 'healthy/nested/AGENTS.md'],
      truncated: false,
      failures: [
        { path: 'broken/AGENTS.md', message: 'Unavailable' },
        { path: 'unknown/AGENTS.md', message: 'Root guidance lookup failed.' },
        { path: 'incomplete/AGENTS.md', message: 'Root guidance lookup is incomplete.' },
        { path: 'nested/AGENTS.md', message: 'Nested guidance lookup failed.' },
        { path: 'other/AGENTS.md', message: 'Nested unavailable' },
      ],
    });
    await expect(listInstructionFilesAcrossRoots([roots[1]!], 10, '**/*.mdc')).rejects.toThrow('Unavailable');
  });
});
