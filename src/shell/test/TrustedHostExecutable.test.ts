import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { outsideWorkspace, repositoryEnvironment, trustedHostExecutable } from '#src/shell/TrustedHostExecutable.js';

afterEach(() => vi.unstubAllEnvs());
it('keeps repository helpers outside writable projects and omits process-startup overrides', () => {
  const base = mkdtempSync(join(tmpdir(), 'glyph-trusted-program-'));
  try {
    const home = join(base, 'home'),
      project = join(base, 'project');
    mkdirSync(home);
    mkdirSync(project);
    vi.stubEnv('HOME', home);
    vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
    vi.stubEnv('XDG_CONFIG_HOME', undefined);
    vi.stubEnv('PATH', project);
    vi.stubEnv('GIT_EXEC_PATH', project);
    vi.stubEnv('LD_PRELOAD', 'fixture');
    vi.stubEnv('SSH_AUTH_SOCK', join(home, 'socket'));
    const env = repositoryEnvironment([project]);
    expect(env.PATH).not.toContain(project);
    expect(env).not.toHaveProperty('GIT_EXEC_PATH');
    expect(env).not.toHaveProperty('LD_PRELOAD');
    expect(env.SSH_AUTH_SOCK).toBe(join(home, 'socket'));
    expect(trustedHostExecutable('git', [project])).toMatch(/^\//u);
    expect(trustedHostExecutable('sh', [project])).toBe(realpathSync('/bin/sh'));
    expect(trustedHostExecutable('node', [project])).toBe(realpathSync(process.execPath));
    expect(() => trustedHostExecutable('git', ['/'])).toThrow('trusted git');
    expect(outsideWorkspace(join(home, 'future'), [project])).toBe(join(realpathSync(home), 'future'));
    writeFileSync(join(project, 'config'), '');
    symlinkSync(join(project, 'config'), join(home, '.gitconfig'));
    expect(() => repositoryEnvironment([project])).toThrow('outside writable workspaces');
    vi.stubEnv('GIT_CONFIG_GLOBAL', 'relative');
    expect(() => repositoryEnvironment([project])).toThrow('outside writable workspaces');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(project, 'config'));
    expect(() => repositoryEnvironment([project])).toThrow('outside writable workspaces');
    writeFileSync(join(home, 'explicit-config'), '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(home, 'explicit-config'));
    expect(repositoryEnvironment([project]).GIT_CONFIG_GLOBAL).toBe(join(realpathSync(home), 'explicit-config'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it('uses fixed system programs on Windows and rejects unavailable interpreters', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  try {
    expect(repositoryEnvironment([]).PATH).toContain('System32');
    expect(() => trustedHostExecutable('git', ['/'])).toThrow('trusted git');
    expect(() => trustedHostExecutable('sh', [])).toThrow('trusted sh');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});
