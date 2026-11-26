import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

/** A host-owned source for immutable objects that the native sandbox can verify. */
export interface ShellContentStore {
  readonly root: string;
  readonly layout: 'sha512-prefix-2';
  readonly executableSuffix: string;
}

/** The helper receives only the selected command root. Check every attachment before granting a store. */
export function externalShellContentStores(
  stores: readonly ShellContentStore[],
  workspaceRoots: readonly string[],
): readonly ShellContentStore[] {
  return stores.filter(({ root }) => {
    try {
      return (
        realpathSync(root) === root &&
        workspaceRoots.every(path => {
          const workspace = realpathSync(path);
          return !within(workspace, root) && !within(root, workspace);
        })
      );
    } catch {
      return false;
    }
  });
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
