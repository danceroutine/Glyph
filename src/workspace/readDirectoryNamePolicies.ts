import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import type { FilesystemNamePolicy } from './FilesystemNamePolicy.ts';
import { filesystemPolicyDirectory } from './workspaceCaseSensitivity.ts';

/** The context index can answer independent metadata requests over one process without building an index. */
export function readDirectoryNamePolicies(binaryPath: string, directories: readonly string[]): FilesystemNamePolicy[] {
  const parents = directories.map(directory => filesystemPolicyDirectory(directory));
  const unique = [...new Set(parents)];
  if (unique.length === 0) return [];
  const requests = unique.map((params, id) =>
    JSON.stringify({ version: 1, id, method: 'filesystemNamePolicy', params }),
  );
  const output = execFileSync(binaryPath, [], {
    input: requests.join('\n') + '\n',
    encoding: 'utf8',
    timeout: 5000,
    env: {},
    maxBuffer: 1024 + 512 * unique.length,
  });
  const responses = output
    .trimEnd()
    .split('\n')
    .map(line => response.parse(JSON.parse(line)));
  const policies = new Map(responses.map(({ id, result }) => [unique[id], result]));
  return parents.map(parent => {
    const policy = policies.get(parent);
    if (!policy) throw new Error('The filesystem did not return a filename policy for every directory.');
    return policy;
  });
}

const response = z.object({
  id: z.number().int().nonnegative(),
  result: z.object({ caseSensitive: z.boolean(), normalizesUnicode: z.boolean(), foldsUnicode: z.boolean() }),
});
