import { describe, expect, it, vi } from 'vitest';
import { AgentModeID } from "#src/chat/AgentMode.js";
import type { Tool } from '#src/tools/Tool.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import { ToolRegistry } from '#src/tools/ToolRegistry.js';

function tool(namespace = 'project', name = 'read'): Tool {
  return {
    namespace,
    name,
    description: 'Read',
    inputKind: ToolInputKind.JSON,
    allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
    validateInput: vi.fn(),
    execute: vi.fn(async () => 'read'),
  };
}
describe(ToolRegistry, () => {
  it('resolves the qualified tool and preserves registration order', () => {
    const a = tool('server-a');
    const b = tool('server-b');
    const registry = new ToolRegistry([a, b]);
    expect(registry.tools.map(({ namespace, name }) => [namespace, name])).toEqual([
      [a.namespace, a.name],
      [b.namespace, b.name],
    ]);
    expect(registry.resolve({ namespace: 'server-b', name: 'read' }).namespace).toBe(b.namespace);
    expect(() => registry.resolve({ name: 'read' })).toThrow('Ambiguous');
    expect(() => registry.resolve({ namespace: 'missing', name: 'read' })).toThrow('Unknown');
  });
  it('allows a missing namespace only when the name is unambiguous', () => {
    const registry = new ToolRegistry([tool()]);
    expect(registry.resolve({ name: 'read' }).namespace).toBe('project');
    expect(() => registry.resolve({ name: 'write' })).toThrow('Unknown');
    expect(() => new ToolRegistry([tool(), tool()])).toThrow('Duplicate');
  });
  it.each([undefined, [], ['unrecognized']])(
    'rejects missing, empty, or invalid permissions at registration: %j',
    allowedModes => {
      const value = tool();
      expect(() => new ToolRegistry([{ ...value, allowedModes } as unknown as Tool])).toThrow('explicitly declare');
    },
  );
  it('snapshots identity, mode permissions, and handlers at registration', async () => {
    const original = tool();
    const registry = new ToolRegistry([original]);
    const replacement = vi.fn(async () => 'replaced');
    Object.assign(original, { name: 'different', allowedModes: [AgentModeID.AGENT] });
    Object.assign(original, { execute: replacement });
    const registered = registry.resolve({ name: 'read' });
    expect(registered.allowedModes).toContain(AgentModeID.PLAN);
    await expect(registered.execute('{}', new AbortController().signal, { mode: AgentModeID.PLAN })).resolves.toBe(
      'read',
    );
    expect(replacement).not.toHaveBeenCalled();
  });
  it('requires an explicit permission declaration in the TypeScript contract', () => {
    // @ts-expect-error Missing allowedModes must remain a compile-time error.
    const missingModes: Tool = {
      namespace: 'new',
      name: 'new',
      description: 'New tool',
      inputKind: ToolInputKind.JSON,
      validateInput: vi.fn(),
      execute: vi.fn(async () => 'read'),
    };
    expect(() => new ToolRegistry([missingModes])).toThrow('explicitly declare');
  });
});
