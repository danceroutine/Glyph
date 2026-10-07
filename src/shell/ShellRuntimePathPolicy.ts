import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigurationError } from '../errors/ConfigurationError.ts';

/** Rejects host-owned state and trace destinations that a project command could replace. */
export function assertShellRuntimePathIsolation(
  workspaceRoots: readonly string[],
  stateDirectory: string,
  traceFile: string,
): void {
  for (const root of workspaceRoots) {
    if (pathsOverlap(stateDirectory, root)) {
      throw new ConfigurationError(
        'GLYPH_CONFIG_DIR must be outside every project root because Glyph state contains credentials and provider traces.',
      );
    }
    if (pathsOverlap(traceFile, root)) {
      throw new ConfigurationError(
        'CHAT_TRACE_FILE must be outside every project root because Glyph writes trusted provider data to it.',
      );
    }
  }
}

export function pathsOverlap(left: string, right: string): boolean {
  const leftPath = resolveAvailableIdentity(left);
  const rightPath = resolveAvailableIdentity(right);
  const fromLeft = relative(leftPath, rightPath);
  const fromRight = relative(rightPath, leftPath);
  return (
    !fromLeft ||
    (!fromLeft.startsWith(`..${sep}`) && fromLeft !== '..' && !isAbsolute(fromLeft)) ||
    !fromRight ||
    (!fromRight.startsWith(`..${sep}`) && fromRight !== '..' && !isAbsolute(fromRight))
  );
}

function resolveAvailableIdentity(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    missing.push(basename(existing));
    existing = parent;
  }
  return missing.reverse().reduce((current, component) => join(current, component), realpathSync(existing));
}
