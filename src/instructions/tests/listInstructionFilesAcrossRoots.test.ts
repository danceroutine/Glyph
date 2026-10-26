import { describe, expect, it, vi } from 'vitest';
import { listInstructionFilesAcrossRoots } from '#src/instructions/listInstructionFilesAcrossRoots.js';

describe(listInstructionFilesAcrossRoots, () => {
  it('qualifies multiple roots and reports that later roots were excluded by the limit', async () => {
    const first = { glob: vi.fn(async () => ({ files: ['AGENTS.md'], truncated: false })) };
    const second = { glob: vi.fn(async () => ({ files: ['nested/AGENTS.md'], truncated: false })) };

    await expect(
      listInstructionFilesAcrossRoots(
        [
          { name: 'one', index: first },
          { name: 'two', index: second },
        ],
        1,
        '**/AGENTS.md',
      ),
    ).resolves.toEqual({ files: ['one/AGENTS.md'], truncated: true });
    expect(first.glob).toHaveBeenCalledExactlyOnceWith('**/AGENTS.md', { limit: 1 });
    expect(second.glob).not.toHaveBeenCalled();
  });

  it('preserves single-root paths and provider truncation', async () => {
    const index = { glob: vi.fn(async () => ({ files: ['AGENTS.md'], truncated: true })) };
    await expect(listInstructionFilesAcrossRoots([{ name: 'one', index }], 2, '**/AGENTS.md')).resolves.toEqual({
      files: ['AGENTS.md'],
      truncated: true,
    });
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
    await expect(listInstructionFilesAcrossRoots([{ name: 'one', index }], 0, '**/AGENTS.md')).resolves.toEqual({
      files: [],
      truncated: true,
    });
    expect(index.glob).not.toHaveBeenCalled();
  });

  it('propagates native failure for the provider to report without a filesystem fallback', async () => {
    const error = new Error('Index unavailable');
    const index = { glob: vi.fn().mockRejectedValue(error) };
    await expect(listInstructionFilesAcrossRoots([{ name: 'one', index }], 10, '**/AGENTS.md')).rejects.toBe(error);
  });
});
