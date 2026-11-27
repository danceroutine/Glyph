import { describe, expect, it, vi } from 'vitest';
import { listUserRuleFiles } from '#src/instructions/rules/listUserRuleFiles.js';

describe(listUserRuleFiles, () => {
  it('qualifies rules-directory index results for the user store and preserves truncation', async () => {
    const index = { glob: vi.fn(async () => ({ files: ['style.mdc', 'nested/other.mdc'], truncated: true })) };
    await expect(listUserRuleFiles(index, 10)).resolves.toEqual({ files: ['rules/style.mdc'], truncated: true });
    expect(index.glob).toHaveBeenCalledExactlyOnceWith('*.mdc', { limit: 10, rootFilesOnly: true });
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

it('passes turn cancellation to the user index and stops after an aborted result', async () => {
  const control = new AbortController();
  const glob = vi.fn(async () => {
    control.abort(new Error('user index cancelled'));
    return { files: [], truncated: false };
  });
  await expect(listUserRuleFiles({ glob }, 5, control.signal)).rejects.toThrow('user index cancelled');
  expect(glob).toHaveBeenCalledExactlyOnceWith('*.mdc', { limit: 5, rootFilesOnly: true, signal: control.signal });
  await expect(listUserRuleFiles({ glob }, 5, control.signal)).rejects.toThrow('user index cancelled');
  expect(glob).toHaveBeenCalledOnce();
});
