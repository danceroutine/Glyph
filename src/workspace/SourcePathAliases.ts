import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const missingPath = z.object({ code: z.literal('ENOENT') });
const sourcePaths = z.array(z.string());

export type SourcePathAliases = (path: string, descendants?: boolean) => readonly string[];

/** Preserve prospective and recently removed names below their nearest existing physical directory. */
export function storedSourcePath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (!missingPath.safeParse(error).success) throw error;
    return join(storedSourcePath(dirname(path)), basename(path));
  }
}

/** Linux mount points can expose any ancestor or descendant independently of its original name. */
export function readSourcePathAliases(executable: string, path: string, descendants = false): readonly string[] {
  const stored = storedSourcePath(path);
  if (process.platform !== 'linux') return [stored];
  const aliases = sourcePaths.parse(
    JSON.parse(
      execFileSync(executable, ['--source-path-aliases'], {
        input: JSON.stringify([stored, descendants]),
        encoding: 'utf8',
        env: {},
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      }),
    ),
  );
  return [...new Set([stored, ...aliases])];
}
