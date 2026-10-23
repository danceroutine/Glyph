import { describe, expect, it, vi } from 'vitest';
import { ProposalReviewCheckpoint } from '#src/editing/reviews/ProposalReviewCheckpoint.js';

describe(ProposalReviewCheckpoint, () => {
  it('keeps intent persistence separate from completion and propagates an intent failure', async () => {
    const failure = new Error('intent could not be saved');
    const writeIntent = vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const writeOutcome = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const checkpoint = new ProposalReviewCheckpoint(writeIntent, writeOutcome);

    await expect(checkpoint.saveIntent()).rejects.toBe(failure);
    expect(checkpoint.hasPendingCheckpoint).toBe(false);
    await checkpoint.saveIntent();
    expect(writeOutcome).not.toHaveBeenCalled();

    checkpoint.markWorkspaceChanged();
    await checkpoint.saveIntent();
    expect(checkpoint.hasPendingCheckpoint).toBe(true);
    expect(writeOutcome).not.toHaveBeenCalled();
  });

  it('retains a confirmed workspace change through failed and in-flight outcome saves until a retry succeeds', async () => {
    const failure = new Error('outcome could not be saved');
    let finish!: () => void;
    const writing = new Promise<void>(resolve => {
      finish = resolve;
    });
    const writeIntent = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const writeOutcome = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(() => writing);
    const checkpoint = new ProposalReviewCheckpoint(writeIntent, writeOutcome);

    await checkpoint.flushPendingCheckpoint();
    expect(writeOutcome).not.toHaveBeenCalled();
    checkpoint.markWorkspaceChanged();
    expect(checkpoint.hasPendingCheckpoint).toBe(true);
    await expect(checkpoint.saveOutcome()).rejects.toBe(failure);
    expect(checkpoint.hasPendingCheckpoint).toBe(true);

    const retry = checkpoint.flushPendingCheckpoint();
    expect(checkpoint.hasPendingCheckpoint).toBe(true);
    finish();
    await retry;
    expect(checkpoint.hasPendingCheckpoint).toBe(false);
    await checkpoint.flushPendingCheckpoint();
    expect(writeOutcome).toHaveBeenCalledTimes(2);
    expect(writeIntent).not.toHaveBeenCalled();
  });
});
