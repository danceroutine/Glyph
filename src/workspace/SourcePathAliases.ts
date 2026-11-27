import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

const cyclicPath = z.object({ code: z.literal('ELOOP') });
const missingPath = z.object({ code: z.literal('ENOENT') });
const sourcePaths = z.array(z.string());

export interface SourcePathAliases {
  (path: string, descendants?: boolean): readonly string[];
  /** Resolve a complete inventory against one mount table in one helper process. */
  batch?(paths: readonly string[]): readonly string[];
}

/** Preserve prospective and recently removed names below their nearest existing physical directory. */
export function storedSourcePath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (cyclicPath.safeParse(error).success) {
      // A verified cycle of terminal links has no directory contents. Keep the reserved entry's physical parent.
      const reserved = physicalEntry(path);
      let current = reserved;
      const visited = new Set<string>();
      while (visited.size < 128) {
        if (visited.has(current)) return reserved;
        visited.add(current);
        const target = readlinkSync(current);
        // Preserve a relative target's embedded ".." until realpath resolves its parent.
        current = physicalEntry(isAbsolute(target) ? target : dirname(current) + '/' + target);
      }
    }
    if (!missingPath.safeParse(error).success) throw error;
    return join(storedSourcePath(dirname(path)), basename(path));
  }
}

function physicalEntry(value: string): string {
  return join(realpathSync.native(dirname(value)), basename(value));
}

/** Linux mount points can expose any ancestor or descendant independently of its original name. */
export function readSourcePathAliases(
  executable: string,
  path: string | readonly string[],
  descendants = false,
): readonly string[] {
  const stored = (typeof path === 'string' ? [path] : path).map(entry => storedSourcePath(entry));
  if (process.platform !== 'linux') return stored;
  const input = JSON.stringify([typeof path === 'string' ? stored[0] : stored, descendants]);
  const aliases = sourcePaths.parse(
    JSON.parse(
      execFileSync(executable, ['--source-path-aliases'], {
        input,
        encoding: 'utf8',
        env: {},
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024 + Buffer.byteLength(input),
      }),
    ),
  );
  return [...new Set([...stored, ...aliases])];
}
