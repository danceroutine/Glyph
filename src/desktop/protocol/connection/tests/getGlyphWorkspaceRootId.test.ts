import { describe, expect, it } from 'vitest';
import { getGlyphWorkspaceRootId } from '#src/desktop/protocol/connection/getGlyphWorkspaceRootId.js';
import { ProjectContextIdentity } from '#src/project/context/ProjectContextIdentity.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';

describe(getGlyphWorkspaceRootId, () => {
  it.each(['My Project', 'café', 'mail@project', 'root@file%3A%2F%2F%2Fworkspace%2Fproject'])(
    'preserves the existing review mutation scope for a unique %s root',
    name => {
      const root = { name, uri: 'file:///workspace/project' };
      const scope = (name: string) =>
        ProjectContextIdentity.createMutationScope(ProjectContextKind.FOLDER, 'file', [
          { name, path: '/workspace/project' },
        ]);
      expect(scope(getGlyphWorkspaceRootId(root, [root]))).toBe(scope(name));
    },
  );
  it('keeps URI-derived routing separate from a friendly name that resembles a generated identifier', () => {
    const roots = [
      { name: 'A/B', uri: 'file:///workspace/project' },
      { name: 'root@file%3A%2F%2F%2Fworkspace%2Fproject', uri: 'file:///workspace/other' },
    ];
    const ids = roots.map(root => getGlyphWorkspaceRootId(root, roots));
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toBe(roots[1]!.name);
  });
});
