import { describe, expect, it } from 'vitest';
import { WorkspaceProtectedPathRegistry } from '#src/workspace/policy/WorkspaceProtectedPathRegistry.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';

describe(WorkspaceProtectedPathRegistry, () => {
  it('updates every live policy and retains earlier physical profiles after retargeting', () => {
    const registry = new WorkspaceProtectedPathRegistry();
    const first = new WorkspaceAccessPolicy({}, () => registry.current);
    expect(first.revision).toBe(0);
    registry.admit(['/host/old/skill-state.json']);
    const snapshot = registry.current;
    const second = new WorkspaceAccessPolicy({}, () => registry.current);
    expect(first.revision).toBe(1);
    registry.admit(['/host/new/skill-state.json']);
    registry.admit(['/host/new/skill-state.json']);
    expect(registry.current).toEqual(['/host/old/skill-state.json', '/host/new/skill-state.json']);
    expect(snapshot).toEqual(['/host/old/skill-state.json']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    for (const policy of [first, second]) {
      expect(policy.exclusionsFor('/host', true).excludedPaths).toEqual([
        'old/skill-state.json',
        'new/skill-state.json',
      ]);
      expect(policy.revision).toBe(2 - Number(policy === second));
      expect(policy.revision).toBe(2 - Number(policy === second));
    }
    const mutable = ['/a'];
    const fixed = new WorkspaceAccessPolicy({}, mutable);
    expect(fixed.privatePaths).toEqual(['/a']);
    mutable[0] = '/b';
    expect(fixed.revision).toBe(2);
    expect(fixed.privatePaths).toEqual(['/b']);
  });
});
