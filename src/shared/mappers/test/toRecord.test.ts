import { describe, expect, it } from 'vitest';
import { ProtocolError } from '#src/errors/ProtocolError.js';
import { toRecord } from '#src/shared/mappers/toRecord.js';

describe(toRecord, () => {
  it('returns plain objects unchanged', () => {
    const value = { ok: true };

    expect(toRecord(value)).toBe(value);
  });

  it.each([null, undefined, 0, '', 'text', 42, true, []])('rejects %j as an unexpected response shape', value => {
    expect(() => toRecord(value)).toThrow(ProtocolError);
    expect(() => toRecord(value)).toThrow('Unexpected server response shape.');
  });
});
