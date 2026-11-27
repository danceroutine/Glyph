import fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { sameWorkspaceDirectory, WorkspaceDirectoryIdentity } from '#src/workspace/sameWorkspaceDirectory.js';

it('compares physical entries and falls back to configured casing for absent directory pairs', () => {
  const root = mkdtempSync(join(tmpdir(), 'glyph-directory-identity-'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const a = join(root, 'ſkills'),
    b = join(root, 'skills');
  expect(sameWorkspaceDirectory(a, a, true)).toBe(true);
  expect(sameWorkspaceDirectory(a, root, true)).toBe(false);
  expect(sameWorkspaceDirectory(a, b, true)).toBe(false);
  expect(sameWorkspaceDirectory(join(root, 'OLD'), join(root, 'old'), false)).toBe(true);
  mkdirSync(a);
  const shared = mkdirSync(b, { recursive: true }) === undefined;
  expect(sameWorkspaceDirectory(a, b, true)).toBe(shared);
  expect(sameWorkspaceDirectory(b, a, false)).toBe(shared);
});

it('distinguishes missing, inaccessible, and distinct entries whose spellings could fold', () => {
  const stored = { dev: 1n, ino: 1n } as never;
  const lstat = vi.spyOn(fs, 'lstatSync');
  try {
    for (const [left, right] of [
      [undefined, stored],
      [stored, undefined],
      [stored, { dev: 1n, ino: 2n }],
      [stored, { dev: 2n, ino: 1n }],
    ]) {
      lstat.mockReturnValueOnce(left as never).mockReturnValueOnce(right as never);
      expect(sameWorkspaceDirectory('/a', '/A', false)).toBe(false);
    }
    lstat.mockImplementationOnce(() => {
      throw new Error('Access denied');
    });
    expect(sameWorkspaceDirectory('/A', '/a', false)).toBe(false);
  } finally {
    lstat.mockRestore();
  }
});

it('checks repeated catalog directory spellings once per synchronous batch', async () => {
  const identity = new WorkspaceDirectoryIdentity('/root/SKILLS', false);
  const lstat = vi.spyOn(fs, 'lstatSync').mockReturnValue(undefined as never);
  try {
    expect(identity.matches('/root/skills')).toBe(true);
    expect(identity.matches('/root/skills')).toBe(true);
    expect(lstat).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(identity.matches('/root/skills')).toBe(true);
    expect(lstat).toHaveBeenCalledTimes(4);
  } finally {
    lstat.mockRestore();
  }
});
