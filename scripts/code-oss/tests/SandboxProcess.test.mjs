import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hostProcessId, processExists } from '#code-oss/tests/electron/SandboxProcess.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it('translates namespace PIDs only within the fixture application tree', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.mocked(execFileSync).mockReturnValue('504 503\n502 500\n503 502\n900 1\n500 1\n');
  vi.mocked(readFile).mockImplementation(async path => {
    if (path === '/proc/502/status') return 'NSpid:\t502\n';
    if (path === '/proc/503/status') return 'NSpid:\t503\t1\n';
    if (path === '/proc/504/status') return 'NSpid:\t504\t3\n';
    throw new Error('Read outside fixture tree');
  });
  expect(await hostProcessId(500, 3)).toBe(504);
  expect(readFile).not.toHaveBeenCalledWith('/proc/900/status', 'utf8');
});

it('rejects ambiguous or missing evidence instead of probing an unrelated host PID', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.mocked(execFileSync).mockReturnValue('501 500\n502 500\n');
  vi.mocked(readFile).mockResolvedValue('NSpid:\t501\t3\n');
  await expect(hostProcessId(500, 3)).rejects.toThrow('found 2');
  vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
  await expect(hostProcessId(500, 3)).rejects.toThrow('found 0');
  vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(hostProcessId(500, 3)).rejects.toThrow('denied');
});

it('keeps native PIDs on macOS and rejects invalid fixture IDs', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  expect(await hostProcessId(500, 504)).toBe(504);
  await expect(hostProcessId(undefined, 504)).rejects.toThrow('fixture');
  await expect(hostProcessId(500, 1)).rejects.toThrow('fixture');
});

it('proves disappearance using ESRCH, never permission denial', () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(processExists(504)).toBe(true);
  kill.mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  expect(processExists(504)).toBe(false);
  kill.mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  expect(() => processExists(504)).toThrow('denied');
});
