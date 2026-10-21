import { describe, expect, it, vi } from 'vitest';
import { diffArrays, type ChangeObject } from 'diff';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';

vi.mock('diff', { spy: true });

it('enforces a monotonic deadline while scanning a common prefix even when the wall clock is frozen', () => {
  let elapsed = 0;
  const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => elapsed++);
  const wall = vi.spyOn(Date, 'now').mockReturnValue(0);
  const common = 'unchanged\n'.repeat(100);
  try {
    expect(() =>
      new JsDiffTextDiffer().createReviewItems('file', `${common}old\n`, `${common}new\n`, { timeoutMs: 10 }),
    ).toThrow(expect.objectContaining({ reason: EditFailureReason.LIMIT_EXCEEDED }));
    expect(elapsed).toBeLessThan(20);
  } finally {
    monotonic.mockRestore();
    wall.mockRestore();
  }
});

describe(JsDiffTextDiffer, () => {
  describe(JsDiffTextDiffer.prototype.createReviewItems, () => {
    it('treats a line diff with missing entries as reporting no further changes', () => {
      const changes: ChangeObject<string[]>[] = [{ value: ['same\n'], count: 1, added: false, removed: false }];
      changes.length = 2;
      vi.mocked(diffArrays).mockReturnValueOnce(changes);

      const items = new JsDiffTextDiffer().createReviewItems('file', 'same\nold\n', 'same\nnew\n', {
        timeoutMs: 1_000,
      });

      expect(vi.mocked(diffArrays).mock.results.at(-1)?.value).toBe(changes);
      expect(items).toEqual([]);
    });
  });
});
