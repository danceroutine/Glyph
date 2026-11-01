import { describe, expect, it, vi } from 'vitest';
import { AgentInstructionActivationMode } from '#src/instructions/AgentInstructionSource.js';
import { UserAgentRuleManager, withEnabled__TESTING_ONLY } from '#src/instructions/rules/UserAgentRuleManager.js';

describe(UserAgentRuleManager, () => {
  it('reconciles indexed paths before publishing the catalog after every successful mutation', async () => {
    const events: string[] = [];
    const workspace = {
      create: vi.fn(async () => {
        events.push('create');
      }),
      read: vi.fn(async () => ({ text: '---\nname: Test\n---\nBody', revision: 'one', byteOrderMark: false })),
      replace: vi.fn(async () => {
        events.push('replace');
      }),
      delete: vi.fn(async () => {
        events.push('delete');
      }),
      normalizePath: (path: string) => path,
    };
    const index = {
      refresh: vi.fn(async () => {
        events.push('index');
        return { root: '/rules', fileCount: 1, fromCache: false, truncated: false, durationMilliseconds: 0 };
      }),
    };
    const catalog = {
      refresh: vi.fn(async () => {
        events.push('catalog');
        return [];
      }),
    };
    const manager = new UserAgentRuleManager(workspace as never, catalog, index);
    await manager.create('Test', AgentInstructionActivationMode.MANUAL);
    await manager.setEnabled('rules/test.mdc', 'one', false);
    await manager.remove('rules/test.mdc', 'one');
    expect(events).toEqual(['create', 'index', 'catalog', 'replace', 'index', 'catalog', 'delete', 'index', 'catalog']);
    events.length = 0;
    workspace.delete.mockRejectedValueOnce(new Error('Stale revision'));
    await expect(manager.remove('rules/test.mdc', 'stale')).rejects.toThrow('Stale revision');
    expect(events).toEqual([]);
    index.refresh.mockRejectedValueOnce(new Error('Index unavailable'));
    await expect(manager.create('Other', AgentInstructionActivationMode.MANUAL)).rejects.toThrow('Index unavailable');
    expect(events).toEqual(['create']);
  });

  it('creates a safe user rule and refreshes discovery', async () => {
    const create = vi.fn(async (_path: string, _content: string, _overwrite: boolean) => ({}));
    const refresh = vi.fn(async () => []);
    const manager = new UserAgentRuleManager({ create } as never, { refresh });
    await manager.create('TypeScript Safety', AgentInstructionActivationMode.MODEL);
    expect(create).toHaveBeenCalledWith(
      'rules/typescript-safety.mdc',
      expect.stringContaining('activation: model'),
      false,
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('updates an existing enabled field without replacing the rule body', () => {
    expect(withEnabled__TESTING_ONLY('---\nname: Test\nenabled: true\n---\n\nBody\n', false)).toBe(
      '---\nname: Test\nenabled: false\n---\n\nBody\n',
    );
  });

  it('inserts a missing enabled field', () => {
    expect(withEnabled__TESTING_ONLY('---\nname: Test\n---\nBody', true)).toBe(
      '---\nname: Test\nenabled: true\n---\nBody',
    );
  });

  it('validates names and preserves a bounded safe slug', async () => {
    const create = vi.fn(async (_path: string, _content: string, _overwrite: boolean) => ({}));
    const manager = new UserAgentRuleManager({ create } as never, { refresh: vi.fn(async () => []) });
    await expect(manager.create('   ', AgentInstructionActivationMode.MANUAL)).rejects.toThrow('cannot be empty');
    await expect(manager.create('---', AgentInstructionActivationMode.MANUAL)).rejects.toThrow(
      'must contain a letter or number',
    );
    await manager.create(` ${'A'.repeat(100)} `, AgentInstructionActivationMode.ALWAYS);
    expect(create.mock.calls[0]?.[0]).toBe(`rules/${'a'.repeat(80)}.mdc`);
  });

  it('updates and removes only revision-matched user rule paths', async () => {
    const read = vi.fn(async () => ({ text: '---\nname: Test\n---\nBody', revision: 'one', byteOrderMark: null }));
    const replace = vi.fn(async () => ({}));
    const remove = vi.fn(async () => ({}));
    const normalizePath = vi.fn((path: string) => path.replace('~/.glyph/', ''));
    const refresh = vi.fn(async () => []);
    const manager = new UserAgentRuleManager({ read, replace, delete: remove, normalizePath } as never, { refresh });

    await manager.setEnabled('~/.glyph/rules/test.mdc', 'one', false);
    expect(replace).toHaveBeenCalledWith('rules/test.mdc', 'one', '---\nname: Test\nenabled: false\n---\nBody', null);
    await manager.remove('rules/test.mdc', 'one');
    expect(remove).toHaveBeenCalledWith('rules/test.mdc', 'one');
    expect(refresh).toHaveBeenCalledTimes(2);

    await expect(manager.setEnabled('rules/test.mdc', 'stale', true)).rejects.toThrow('The rule changed');
    await expect(manager.remove('../test.mdc', 'one')).rejects.toThrow('Only user rules');
  });

  it('rejects enabling rules without valid frontmatter', () => {
    expect(() => withEnabled__TESTING_ONLY('Body only', true)).toThrow('needs YAML frontmatter');
    expect(() => withEnabled__TESTING_ONLY('---\nname: Test', true)).toThrow('invalid YAML frontmatter');
  });
});
