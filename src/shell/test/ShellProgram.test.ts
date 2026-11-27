import { expect, it } from 'vitest';
import { ShellProgram } from '#src/shell/ShellProgram.js';

it('pins argument boundaries and displays control characters without parsing shell syntax', () => {
  const args = ['', 'two\\\\slashes', 'trailing\\', "quote'", 'line\nbreak', '$(false)'];
  const program = new ShellProgram('/usr/bin/node', args, 'Reviewed program');
  args[0] = 'changed';
  expect(program.arguments[0]).toBe('');
  expect(program.display).toBe(
    'Reviewed program\n' +
      ['/usr/bin/node', '', 'two\\\\slashes', 'trailing\\', "quote'", 'line\nbreak', '$(false)']
        .map(value => JSON.stringify(value))
        .join(' '),
  );
  expect(Object.isFrozen(program)).toBe(true);
  expect(Object.isFrozen(program.arguments)).toBe(true);
});

it.each([
  ['node', []],
  ['/bin/invalid\0', []],
  ['/bin/node', ['invalid\0']],
] as const)('rejects an invalid direct invocation %s', (executable, args) => {
  expect(() => new ShellProgram(executable, args, 'Description')).toThrow('absolute executable');
});
