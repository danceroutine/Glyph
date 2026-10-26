import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';

/**
 * Translate paths from an index rooted at ~/.glyph/rules into the ~/.glyph store namespace.
 * Only direct rule children are eligible. Native truncation remains visible even when
 * nested matches are filtered, so incomplete discovery is never reported as complete.
 */
export async function listUserRuleFiles(
  index: Pick<WorkspacePathIndex, 'glob'>,
  maxFiles: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const result = await index.glob('*.mdc', { limit: maxFiles });
  return {
    files: result.files.filter(path => !path.includes('/')).map(path => `rules/${path}`),
    truncated: result.truncated,
  };
}
