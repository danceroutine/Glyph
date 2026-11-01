import { describe, expect, it, vi } from 'vitest';
import { listUserRuleFiles } from '#src/instructions/rules/listUserRuleFiles.js';

describe(listUserRuleFiles, () => {
  it('qualifies rules-directory index results for the user store and preserves truncation', async () => {
    const index = { glob: vi.fn(async () => ({ files: ['style.mdc', 'nested/other.mdc'], truncated: true })) };
    await expect(listUserRuleFiles(index, 10)).resolves.toEqual({ files: ['rules/style.mdc'], truncated: true });
    expect(index.glob).toHaveBeenCalledExactlyOnceWith('*.mdc', { limit: 10 });
  });

  it('preserves empty results and propagates index failures without a disk fallback', async () => {
    const index = {
      glob: vi
        .fn()
        .mockResolvedValueOnce({ files: [], truncated: false })
        .mockRejectedValueOnce(new Error('Index unavailable')),
    };
    await expect(listUserRuleFiles(index, 10)).resolves.toEqual({ files: [], truncated: false });
    await expect(listUserRuleFiles(index, 10)).rejects.toThrow('Index unavailable');
  });
});
