import { expect, it, vi } from 'vitest';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';

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
