import { describe, expect, it } from 'vitest';
import { ProjectContextIdentity } from '#src/project/context/ProjectContextIdentity.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';

describe(ProjectContextIdentity, () => {
  describe(ProjectContextIdentity.create, () => {
    it('derives the same hexadecimal identity for the same container', () => {
      const first = ProjectContextIdentity.create(ProjectContextKind.FOLDER, 'local', '/project');
      const second = ProjectContextIdentity.create(ProjectContextKind.FOLDER, 'local', '/project');

      expect(first).toMatch(/^[0-9a-f]{64}$/u);
      expect(second).toBe(first);
    });

    it('distinguishes containers by kind, authority, and identity', () => {
      const identities = new Set([
        ProjectContextIdentity.create(ProjectContextKind.FOLDER, 'local', '/project'),
        ProjectContextIdentity.create(ProjectContextKind.WORKSPACE, 'local', '/project'),
        ProjectContextIdentity.create(ProjectContextKind.FOLDER, 'ssh:host', '/project'),
        ProjectContextIdentity.create(ProjectContextKind.FOLDER, 'local', '/other'),
      ]);

      expect(identities.size).toBe(4);
    });
  });

  describe(ProjectContextIdentity.createMutationScope, () => {
    it('ignores the order in which roots are listed', () => {
      const roots = [
        { name: 'web', path: '/web' },
        { name: 'api', path: '/api' },
        { name: 'api', path: '/api-copy' },
        { name: 'api', path: '/api' },
        { name: 'docs', path: '/docs' },
      ];

      const forward = ProjectContextIdentity.createMutationScope(ProjectContextKind.WORKSPACE, 'local', roots);
      const reversed = ProjectContextIdentity.createMutationScope(
        ProjectContextKind.WORKSPACE,
        'local',
        [...roots].reverse(),
      );

      expect(reversed).toBe(forward);
    });

    it('distinguishes roots that share a name but not a path', () => {
      const first = ProjectContextIdentity.createMutationScope(ProjectContextKind.WORKSPACE, 'local', [
        { name: 'api', path: '/one' },
      ]);
      const second = ProjectContextIdentity.createMutationScope(ProjectContextKind.WORKSPACE, 'local', [
        { name: 'api', path: '/two' },
      ]);

      expect(second).not.toBe(first);
    });

    it('does not reorder the caller roots', () => {
      const roots = [
        { name: 'web', path: '/web' },
        { name: 'api', path: '/api' },
      ];

      ProjectContextIdentity.createMutationScope(ProjectContextKind.WORKSPACE, 'local', roots);

      expect(roots.map(root => root.name)).toEqual(['web', 'api']);
    });
  });
});
