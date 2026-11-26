import { describe, expect, it } from 'vitest';
import { InstructionPaths } from '#src/instructions/InstructionPaths.js';

describe(InstructionPaths, () => {
  const roots = new InstructionPaths(
    new Map([
      ['App', false],
      ['app', true],
    ]),
  );
  it('compares paths with the casing of the routed root while preserving distinct aliases', () => {
    expect(roots.contains('App/Src', 'App/src/A.ts')).toBe(true);
    expect(roots.contains('App/Src', 'app/src/A.ts')).toBe(false);
    expect(roots.contains('app/Src', 'app/src/A.ts')).toBe(false);
    expect(roots.caseSensitive('other/path')).toBe(true);
    expect(new InstructionPaths(false).contains('SRC', 'src')).toBe(true);
  });
  it('resolves references through the original root while allowing parents within that root', () => {
    expect(roots.reference('App/src', '../guide.md')).toBe('App/guide.md');
    expect(() => roots.reference('App', '../app/guide.md')).toThrow('leaves');
    expect(() => new InstructionPaths().reference('.', '..')).toThrow('leaves');
    for (const invalid of ['', '/absolute', 'C:local', 'a\\b', 'a\0b'])
      expect(() => roots.reference('App', invalid)).toThrow('relative');
  });
});
