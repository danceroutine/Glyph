import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';

describe(WorkspaceAccessPolicy, () => {
  it('revises immutable private-path snapshots when host reservations change', () => {
    let paths = ['/first'];
    const policy = new WorkspaceAccessPolicy({}, () => paths);
    expect(policy.revision).toBe(1);
    const initial = policy.privatePaths;
    paths = ['/second'];
    expect(policy.revision).toBe(2);
    expect(policy.privatePaths).toEqual(['/second']);
    expect(initial).toEqual(['/first']);
    paths = [...paths, '/third'];
    expect(policy.revision).toBe(3);
    expect(Object.isFrozen(policy.privatePaths)).toBe(true);
  });

  it('projects only actual host paths below the attached root and recognizes private ancestor roots', () => {
    const policy = new WorkspaceAccessPolicy({}, ['/Project/Profile/skill-state.json', '/Project/private']);
    expect(policy.exclusionsFor('/project', false)).toEqual({
      privateRoot: false,
      excludedPaths: ['Profile/skill-state.json', 'private'],
    });
    expect(policy.exclusionsFor('/project', true)).toEqual({ privateRoot: false, excludedPaths: [] });
    expect(policy.exclusionsFor('/Project/private', true).privateRoot).toBe(true);
    expect(policy.exclusionsFor('/Project/private/nested', true).privateRoot).toBe(true);
    expect(policy.exclusionsFor('/Project/private-other', true).privateRoot).toBe(false);
    expect(policy.exclusionsFor('/Project/.SKILL-STAGING', false).privateRoot).toBe(true);
    expect(policy.exclusionsFor('/Project/.SKILL-STAGING', true).privateRoot).toBe(false);
    for (const spelling of ['.ſkill-ﬅaging', '.sKill-ﬆaging']) {
      expect(policy.exclusionsFor('/Project/' + spelling, false).privateRoot).toBe(true);
      expect(policy.isIgnoredDirectory(spelling, false)).toBe(true);
      expect(policy.isIgnoredDirectory(spelling, true)).toBe(false);
    }
    expect(policy.isIgnoredDirectory('DIST', false)).toBe(true);
    expect(policy.isIgnoredDirectory('.skill-staging', true)).toBe(true);
    expect(new WorkspaceAccessPolicy({}, ['/']).exclusionsFor('/nested', true).privateRoot).toBe(true);
  });

  it('uses actual containing-directory aliases independently of configurable filename ignores', () => {
    const root = mkdtempSync(join(tmpdir(), 'glyph-private-name-'));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const policy = new WorkspaceAccessPolicy();
    const name = '.SKILL-STAGING';
    const path = join(root, name);
    expect(policy.isIgnoredDirectory(name, false, path, true)).toBe(false);
    const prospective = policy.isIgnoredDirectory(name, false, path);
    mkdirSync(path);
    const aliases = existsSync(join(root, '.skill-staging'));
    expect(prospective).toBe(aliases);
    expect(policy.isIgnoredDirectory(name, !aliases, path)).toBe(aliases);
    expect(policy.exclusionsFor(path, !aliases, 'native').privateRoot).toBe(aliases);
    expect(
      new WorkspaceAccessPolicy({ ignoredDirectories: ['.skill-staging'] }).isIgnoredDirectory(name, false, path),
    ).toBe(true);
    expect(policy.configuredIgnoredDirectories).not.toContain('.skill-staging');
  });

  describe(WorkspaceAccessPolicy.prototype.isSensitiveFileName, () => {
    it('classifies the shared credential, prefix, extension, and allow-list defaults', () => {
      const policy = new WorkspaceAccessPolicy();

      expect(policy.isSensitiveFileName('.git-credentials')).toBe(true);
      expect(policy.isSensitiveFileName('.env.production')).toBe(true);
      expect(policy.isSensitiveFileName('certificate.pem')).toBe(true);
      expect(policy.isSensitiveFileName('.env.example')).toBe(false);
      expect(policy.isSensitiveFileName('application.ts')).toBe(false);
    });

    it('supports one explicit customized policy for every consumer', () => {
      const policy = new WorkspaceAccessPolicy({
        ignoredDirectories: ['vendor'],
        sensitiveFileNames: ['private.txt'],
        sensitiveFilePrefixes: [],
        sensitiveFileExtensions: [],
        allowedFileNames: [],
      });

      expect(policy.toJSON()).toEqual({
        ignoredDirectories: ['vendor', '.skill-staging'],
        sensitiveFileNames: ['private.txt'],
        sensitiveFilePrefixes: [],
        sensitiveFileExtensions: [],
        allowedFileNames: [],
      });
      expect(policy.isSensitiveFileName('private.txt')).toBe(true);
      expect(policy.isSensitiveFileName('.env')).toBe(false);
    });
  });
});
