import { describe, expect, it } from 'vitest';
import { isRecord } from '#src/desktop/protocol/isRecord.js';

describe(isRecord, () => {
  it.each([
    [{}, true],
    [null, false],
    [[], false],
    ['value', false],
  ] as const)('classifies %j as %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});
