import { beforeEach, it, expect, vi, onTestFinished } from 'vitest';
import { filesystemPolicyDirectory, workspaceCaseSensitivity } from '#src/workspace/workspaceCaseSensitivity.js';

const fs = vi.hoisted(() => ({ opendirSync: vi.fn(), statSync: vi.fn(), lstatSync: vi.fn(), realpathSync: vi.fn() }));
vi.mock('node:fs', async original => ({ ...(await original<typeof import('node:fs')>()), ...fs }));
beforeEach(() => {
  vi.resetAllMocks();
  fs.statSync.mockReturnValue({ dev: 1, isDirectory: () => true });
  fs.realpathSync.mockImplementation((path: string) => path);
});
function entries(names: string[]) {
  fs.opendirSync.mockImplementation(() => {
    let index = 0;
    return { readSync: () => (index < names.length ? { name: names[index++]! } : undefined), closeSync: () => {} };
  });
}
it('uses a real existing ancestor for missing or inaccessible optional directories', () => {
  fs.statSync
    .mockImplementationOnce(() => {
      throw new Error('unavailable');
    })
    .mockReturnValueOnce(undefined);
  expect(filesystemPolicyDirectory('/volume/absent/nope')).toBe('/volume');
});
it.each([
  [undefined, undefined, true],
  [{ dev: 1, ino: 2 }, { dev: 2, ino: 2 }, true],
  [{ dev: 1, ino: 2 }, { dev: 1, ino: 3 }, true],
  [{ dev: 1, ino: 2 }, { dev: 1, ino: 2, nlink: 1n }, false],
  [{ dev: 1, ino: 2 }, { dev: 1, ino: 2, nlink: 2n, isDirectory: () => true }, false],
])('compares actual and alternate names using their filesystem identities', (alternate, actual, expected) => {
  entries(['123', 'Test']);
  fs.lstatSync.mockReturnValueOnce(alternate).mockReturnValueOnce(actual);
  expect(workspaceCaseSensitivity('/root')).toBe(expected);
});
it('distinguishes two names for the same inode and skips inconclusive observations', () => {
  entries(['Test', 'test']);
  expect(workspaceCaseSensitivity('/root')).toBe(true);
  entries(['Test', 'another', 'last']);
  fs.lstatSync
    .mockReturnValueOnce({ dev: 1, ino: 2 })
    .mockReturnValueOnce(undefined)
    .mockReturnValueOnce({ dev: 1, ino: 4 })
    .mockReturnValueOnce({ dev: 1, ino: 4, nlink: 2n, isDirectory: () => false })
    .mockReturnValueOnce(undefined);
  expect(workspaceCaseSensitivity('/root')).toBe(true);
});
it.each(['darwin', 'win32', 'linux'] as const)('bounds name sampling and handles an empty mount on %s', platform => {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...desc, value: platform });
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', desc);
  });
  entries(Array.from({ length: 66 }, (_, i) => String(i)));
  const defaultSensitive = platform === 'linux';
  expect(workspaceCaseSensitivity('/')).toBe(defaultSensitive);
  entries([]);
  expect(workspaceCaseSensitivity('/123')).toBe(defaultSensitive);
  fs.opendirSync.mockImplementation(() => {
    throw new Error('Permission denied');
  });
  fs.statSync
    .mockReturnValueOnce({ isDirectory: () => true })
    .mockReturnValueOnce({ dev: 7 })
    .mockReturnValueOnce({ dev: 4 });
  expect(workspaceCaseSensitivity('/mount')).toBe(defaultSensitive);
});
