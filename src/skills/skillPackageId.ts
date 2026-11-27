import { createHash } from 'node:crypto';

/** Preserve existing selection IDs within the chat/tool limit and bound IDs for deeply nested packages. */
export function skillPackageId(originId: string, directory: string): string {
  const qualified = `${originId}:${directory}`;
  return qualified.length <= 500
    ? qualified
    : `skill-sha256:${createHash('sha256')
        .update(JSON.stringify([originId, directory]))
        .digest('hex')}`;
}
