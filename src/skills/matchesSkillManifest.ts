import { lstatSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillDescriptor } from './SkillDescriptor.ts';

/** Match the indexed manifest and its source directories. Only the registered root may be a folder alias. */
export function matchesSkillManifest(source: Pick<SkillDescriptor, 'uri' | 'path'>, resource: string): boolean {
  try {
    let actual = fileURLToPath(resource);
    let expected = fileURLToPath(source.uri);
    const depth = source.path.split('/').length;
    for (let index = 0; index <= depth; index++) {
      const inspect = index === depth ? statSync : lstatSync;
      const left = inspect(actual, { bigint: true });
      const right = inspect(expected, { bigint: true });
      if (left.dev !== right.dev || left.ino !== right.ino || !(index ? left.isDirectory() : left.isFile()))
        return false;
      actual = dirname(actual);
      expected = dirname(expected);
    }
    return true;
  } catch {
    return false;
  }
}
