import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AgentInstructionActivationMode } from '#src/instructions/AgentInstructionSource.js';
import { parseAgentRuleFile } from '#src/instructions/rules/parseAgentRuleFile.js';
import { UserAgentRuleManager, withEnabled__TESTING_ONLY } from '#src/instructions/rules/UserAgentRuleManager.js';

describe(UserAgentRuleManager, () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'glyph-user-rule-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('keeps the existing file and revision when an enablement edit would exceed the byte limit', async () => {
    const workspace = new FileSystemWorkspaceTextStore(root);
    await mkdir(join(root, 'rules'));
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.alloc(65533, 0x61)]);
    await writeFile(join(root, 'rules/full.mdc'), original);
    const before = await workspace.read('rules/full.mdc');
    const manager = new UserAgentRuleManager(workspace, { refresh: async () => [] });
    await expect(manager.setEnabled('rules/full.mdc', before.revision, false)).rejects.toThrow('64 KiB');
    expect(await readFile(join(root, 'rules/full.mdc'))).toEqual(original);
  });

  it('rejects an ACL change between preflight and publication while preserving the current rule', async () => {
    const workspace = new FileSystemWorkspaceTextStore(root);
    const original = await workspace.create('rules/secure.mdc', 'Protected', false);
    const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('ACL changed'));
    const index = { assertReplaceableMetadata: check, refresh: vi.fn() };
    const manager = new UserAgentRuleManager(workspace, { refresh: async () => [] }, index);
    await expect(manager.setEnabled(original.path, original.revision, false)).rejects.toThrow('ACL changed');
    expect(check.mock.calls).toEqual([['secure.mdc'], ['secure.mdc']]);
    expect((await workspace.read(original.path)).revision).toBe(original.revision);
    expect(index.refresh).not.toHaveBeenCalled();
  });
  it('serializes competing settings callers and rejects the losing reviewed revision', async () => {
    const workspace = new FileSystemWorkspaceTextStore(root);
    await workspace.create('rules/shared.mdc', 'Initial', false);
    const { revision } = await workspace.read('rules/shared.mdc');
    const managers = [true, false].map(
      () => new UserAgentRuleManager(new FileSystemWorkspaceTextStore(root), { refresh: async () => [] }),
    );
    const result = await Promise.allSettled(
      managers.map((manager, i) => manager.setEnabled('rules/shared.mdc', revision, i === 0)),
    );
    expect(result.map(item => item.status).toSorted()).toEqual(['fulfilled', 'rejected']);
    expect(result.find(item => item.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringContaining('The rule changed') }),
    });
  });
  it('reconciles indexed paths before publishing the catalog after every successful mutation', async () => {
    const events: string[] = [];
    const workspace = {
      root,
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
      assertReplaceableMetadata: vi.fn(async () => {}),
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
    index.refresh.mockRejectedValueOnce('service unavailable');
    await expect(manager.remove('rules/test.mdc', 'one')).rejects.toThrow('The rule change was saved.');
  });

  it('creates a safe user rule and refreshes discovery', async () => {
    const create = vi.fn(async (_path: string, _content: string, _overwrite: boolean) => ({}));
    const refresh = vi.fn(async () => []);
    const manager = new UserAgentRuleManager({ root, create } as never, { refresh });
    await manager.create('TypeScript Safety', AgentInstructionActivationMode.MODEL, 'TypeScript code review');
    expect(create).toHaveBeenCalledWith(
      'rules/typescript-safety.mdc',
      expect.stringContaining('activation: model'),
      false,
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('validates and round-trips conditional metadata before creating a file', async () => {
    const create = vi.fn(async (_path: string, _text: string) => ({}));
    const manager = new UserAgentRuleManager({ root, create } as never, { refresh: vi.fn(async () => []) });
    await expect(manager.create('Test', 'model')).rejects.toThrow('description');
    await expect(manager.create('Test', 'file_pattern', '  ')).rejects.toThrow('glob');
    await expect(manager.create('Test', 'file_pattern', '../outside')).rejects.toThrow('Invalid rule glob');
    await expect(manager.create('A'.repeat(65_536), 'manual')).rejects.toThrow('64 KiB');
    expect(create).not.toHaveBeenCalled();
    await manager.create('A "quoted" rule', 'file_pattern', '**/*.ts\n\n*.txt');
    expect(parseAgentRuleFile(create.mock.calls[0]![1])).toMatchObject({
      name: 'A "quoted" rule',
      globs: ['**/*.ts', '*.txt'],
    });
  });

  it('preserves CRLF, the exact Markdown body, and complete delimiter lines when managing enablement', () => {
    for (const text of [
      'First line\r\n---more\r\nLast line\r\n',
      '---\r\n---\r\nFirst line\r\n---more\r\nLast line\r\n',
      '---\r\nenabled: true\r\n---\r\nFirst line\r\n---more\r\nLast line\r\n',
    ]) {
      const updated = withEnabled__TESTING_ONLY(text, false);
      expect(updated).toBe('---\r\nenabled: false\r\n---\r\nFirst line\r\n---more\r\nLast line\r\n');
      expect(parseAgentRuleFile(updated)).toMatchObject({ enabled: false, body: parseAgentRuleFile(text).body });
    }
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
    const manager = new UserAgentRuleManager({ root, create } as never, { refresh: vi.fn(async () => []) });
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
    const manager = new UserAgentRuleManager({ root, read, replace, delete: remove, normalizePath } as never, {
      refresh,
    });

    await manager.setEnabled('~/.glyph/rules/test.mdc', 'one', false);
    expect(replace).toHaveBeenCalledWith(
      'rules/test.mdc',
      'one',
      '---\nname: Test\nenabled: false\n---\nBody',
      null,
      undefined,
    );
    await manager.remove('rules/test.mdc', 'one');
    expect(remove).toHaveBeenCalledWith('rules/test.mdc', 'one');
    expect(refresh).toHaveBeenCalledTimes(2);

    await expect(manager.setEnabled('rules/test.mdc', 'stale', true)).rejects.toThrow('The rule changed');
    await expect(manager.remove('../test.mdc', 'one')).rejects.toThrow('Only user rules');
  });

  it('applies filesystem casing when authorizing a managed path', async () => {
    for (const caseSensitive of [true, false]) {
      const remove = vi.fn(async () => {});
      const manager = new UserAgentRuleManager(
        { root, caseSensitive, normalizePath: (path: string) => path, delete: remove } as never,
        { refresh: async () => [] },
      );
      const operation = manager.remove('RULES/STYLE.MDC', 'one');
      if (caseSensitive) await expect(operation).rejects.toThrow('Only user rules');
      else {
        await operation;
        expect(remove).toHaveBeenCalledWith('RULES/STYLE.MDC', 'one');
      }
    }
  });

  it('rejects enabling rules without valid frontmatter', () => {
    expect(withEnabled__TESTING_ONLY('Body only', true)).toBe('---\nenabled: true\n---\nBody only');
    expect(() => withEnabled__TESTING_ONLY('---\nname: Test', true)).toThrow('closing --- delimiter');
  });
});
