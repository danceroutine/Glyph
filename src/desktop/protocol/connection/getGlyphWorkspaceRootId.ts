import type { GlyphWorkspaceRoot } from './GlyphWorkspaceRoot.ts';

/**
 * Produces one unambiguous path component shared by index, host, and editor.
 * Keep existing safe unique names stable; ambiguous display names use a URI
 * namespace chosen outside the workspace's existing friendly names.
 */
export function getGlyphWorkspaceRootId(
  root: Pick<GlyphWorkspaceRoot, 'name' | 'uri'>,
  roots: readonly Pick<GlyphWorkspaceRoot, 'name' | 'uri'>[],
): string {
  const unique = roots.filter(candidate => candidate.name.toLowerCase() === root.name.toLowerCase()).length === 1;
  // Spaces and Unicode were valid mutation-scope names before routing IDs were
  // introduced. Preserve them so unchanged roots keep their review checkpoint.
  if (
    unique &&
    root.name.length > 0 &&
    !/[/\\\x00-\x1f\x7f]/u.test(root.name) &&
    root.name !== '.' &&
    root.name !== '..'
  )
    return root.name;
  let namespace = 'root@';
  while (roots.some(candidate => candidate.name.toLowerCase().startsWith(namespace))) namespace += '@';
  return `${namespace}${encodeURIComponent(root.uri)}`;
}
