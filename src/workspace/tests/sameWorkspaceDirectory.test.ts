import fs from 'node:fs';
import { existsSync, linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  relativeWorkspaceSpelling,
  sameWorkspaceDirectory,
  WorkspaceDirectoryIdentity,
} from '#src/workspace/sameWorkspaceDirectory.js';

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
  const lstat = vi.spyOn(fs, 'lstatSync').mockReturnValue(undefined);
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

it('compares the actual directory even when its mounted names have unrelated spellings', () => {
  const stat = vi.spyOn(fs, 'lstatSync').mockReturnValue({ dev: 22n, ino: 8n } as never);
  try {
    expect(sameWorkspaceDirectory('/profile/rules', '/other/rules', true)).toBe(true);
    stat.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);
    expect(sameWorkspaceDirectory('/private-A/x', '/private-B/x', false)).toBe(true);
  } finally {
    stat.mockRestore();
  }
});

it('projects only absolute paths below the captured folder', () => {
  const root = tmpdir();
  expect(relativeWorkspaceSpelling(root, root)).toBe('');
  expect(relativeWorkspaceSpelling(root, join(root, 'next'))).toBe('next');
  expect(relativeWorkspaceSpelling(join(root, 'next'), root)).toBeUndefined();
  expect(relativeWorkspaceSpelling(root, 'relative')).toBeUndefined();
  expect(relativeWorkspaceSpelling('relative', root)).toBeUndefined();
});

it('projects a saved spelling when both names identify the same directory entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'glyph-project-spelling-'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const target = join(root, 'workspace');
  mkdirSync(target);
  const saved = join(root, 'Project');
  const reopened = join(root, 'project');
  symlinkSync(target, saved, 'dir');
  const note = join(saved, 'note.md');
  if (!existsSync(reopened)) {
    symlinkSync(target, reopened, 'dir');
    expect(relativeWorkspaceSpelling(reopened, note)).toBeUndefined();
    rmSync(reopened);
    // Give both names the same symlink inode, as a case-insensitive lookup does.
    linkSync(saved, reopened);
  }
  expect(relativeWorkspaceSpelling(reopened, note)).toBe('note.md');
});
