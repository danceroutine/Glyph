import { isAbsolute, join } from 'node:path';
import type { ShellContentStore } from './ShellContentStore.ts';

/** Discover pnpm's v11 object layout from host settings. Project configuration has no authority here. */
export function pnpmContentStore(environment: NodeJS.ProcessEnv, platform = process.platform): ShellContentStore[] {
  if (platform !== 'linux') return [];
  const data = environment.PNPM_HOME ?? (environment.XDG_DATA_HOME && join(environment.XDG_DATA_HOME, 'pnpm'));
  const home = data ?? (environment.HOME && join(environment.HOME, '.local/share/pnpm'));
  const store = environment.PNPM_CONFIG_STORE_DIR ?? environment.npm_config_store_dir ?? (home && join(home, 'store'));
  if (!store || !isAbsolute(store)) return [];
  return [{ root: join(store, 'v11/files'), layout: 'sha512-prefix-2', executableSuffix: '-exec' }];
}
