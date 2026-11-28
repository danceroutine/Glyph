import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { externalShellContentStores } from '#src/shell/ShellContentStore.js';
import { pnpmContentStore } from '#src/shell/pnpmContentStore.js';

it('grants the host pnpm v11 store only when it is physically independent of every attached workspace', () => {
  const admitted = (env: NodeJS.ProcessEnv, roots: string[], platform: NodeJS.Platform) =>
    externalShellContentStores(pnpmContentStore(env, platform), roots);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'glyph-pnpm-store-')));
  onTestFinished(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const project = join(base, 'project');
  mkdirSync(project);
  for (const [environment, store] of [
    [{ HOME: base }, join(base, '.local/share/pnpm/store')],
    [{ XDG_DATA_HOME: base }, join(base, 'pnpm/store')],
    [{ PNPM_HOME: base }, join(base, 'store')],
    [{ PNPM_CONFIG_STORE_DIR: base }, base],
    [{ npm_config_store_dir: base }, base],
  ] as const) {
    const root = join(store, 'v11/files');
    mkdirSync(root, { recursive: true });
    expect(admitted(environment, [project], 'linux')).toEqual([
      { root, layout: 'sha512-prefix-2', executableSuffix: '-exec' },
    ]);
  }
  const alias = join(base, 'alias');
  symlinkSync(base, alias);
  expect(admitted({ PNPM_CONFIG_STORE_DIR: alias }, [project], 'linux')).toEqual([]);
  const env = { PNPM_CONFIG_STORE_DIR: base };
  expect(admitted(env, [project, alias], 'linux')).toEqual([]);
  expect(admitted(env, [join(base, 'v11/files')], 'linux')).toEqual([]);
  mkdirSync(join(base, 'v11/files/inside'));
  expect(admitted(env, [join(base, 'v11/files/inside')], 'linux')).toEqual([]);
  expect(admitted({ HOME: project }, [project], 'linux')).toEqual([]);
  expect(admitted({ PNPM_HOME: 'relative' }, [], 'linux')).toEqual([]);
  expect(admitted({}, [], 'linux')).toEqual([]);
  expect(admitted(env, [project], 'darwin')).toEqual([]);
});
