import { expect, it } from 'vitest';
import { resolveInstructionId } from '#src/instructions/resolveInstructionId.js';

it('resolves former selections only when one current file matches', () => {
  const a = { id: 'a', legacyIds: ['single', 'both'] };
  const b = { id: 'b', legacyIds: ['both'] };
  const c = { id: 'c' };
  const sources = [a, b, c];
  expect(resolveInstructionId(sources, 'single')).toBe(a);
  expect(resolveInstructionId(sources, 'both')).toBeUndefined();
  expect(resolveInstructionId(sources, 'unknown')).toBeUndefined();
  expect(resolveInstructionId(sources, 'c')).toBe(c);
});
