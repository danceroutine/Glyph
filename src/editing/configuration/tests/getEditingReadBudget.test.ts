import { describe, expect, it } from 'vitest';
import type { EditingConfiguration } from '#src/editing/configuration/EditingConfiguration.js';
import { getEditingReadBudget } from '#src/editing/configuration/getEditingReadBudget.js';

function configuration(maxResultingBytesPerFile: number, maxChangedBytes: number): EditingConfiguration {
  return {
    maxRawProposalBytes: 1_024,
    maxChangedBytes,
    maxResultingBytesPerFile,
    maxFiles: 8,
    maxTotalHunks: 16,
    maxHunksPerFile: 8,
    diffBudgetMs: 1_000,
    maxActiveReviews: 1,
    newFileByteOrderMark: false,
    newFileLineEnding: '\n',
  };
}

describe(getEditingReadBudget, () => {
  it('allows the resulting size plus the changed size plus a byte order mark', () => {
    expect(getEditingReadBudget(configuration(100, 20))).toBe(123);
  });

  it('allows a zero-byte configuration to read only a byte order mark', () => {
    expect(getEditingReadBudget(configuration(0, 0))).toBe(3);
  });

  it('rejects a configuration whose combined budget is not a safe integer', () => {
    expect(() => getEditingReadBudget(configuration(Number.MAX_SAFE_INTEGER, 1))).toThrow(
      'Editing read budget must be a safe integer.',
    );
  });

  it('rejects a configuration whose combined budget is smaller than a byte order mark', () => {
    expect(() => getEditingReadBudget(configuration(-10, 0))).toThrow('Editing read budget must be a safe integer.');
  });

  it('rejects a fractional configuration', () => {
    expect(() => getEditingReadBudget(configuration(1.5, 0))).toThrow('Editing read budget must be a safe integer.');
  });
});
