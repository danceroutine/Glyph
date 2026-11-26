import type { GlyphWorkspaceRoot } from './GlyphWorkspaceRoot.ts';

/**
 * Produces one unambiguous path component shared by index, host, and editor.
 * Keep existing safe unique names stable; ambiguous display names use an opaque
 * URI fingerprint in a namespace outside the workspace's friendly names.
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
    !/[/\\\u0000-\u001F\u007F]/u.test(root.name) &&
    root.name !== '.' &&
    root.name !== '..'
  )
    return root.name;
  let namespace = 'root@';
  while (roots.some(candidate => candidate.name.toLowerCase().startsWith(namespace))) namespace += '@';
  // FNV-1a over UTF-8 is synchronous in both the renderer and utility host. The
  // digest is a routing identity, never an authorization or integrity token.
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  for (const byte of new TextEncoder().encode(root.uri))
    hash = BigInt.asUintN(128, (hash ^ BigInt(byte)) * 0x1000000000000000000013bn);
  return `${namespace}${hash.toString(16).padStart(32, '0')}`;
}
