import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import {
  AgentInstructionActivationMode,
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
} from '#src/instructions/AgentInstructionSource.js';
import { AgentRuleInstructionProvider } from '#src/instructions/rules/AgentRuleInstructionProvider.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'glyph-rules-'));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, '.glyph', 'rules'), { recursive: true }),
    mkdir(join(root, 'packages', 'api', '.cursor', 'rules'), { recursive: true }),
    mkdir(join(root, 'packages', 'api', 'docs'), { recursive: true }),
  ]);
  return { root, workspace: new FileSystemWorkspaceTextStore(root) };
}

describe(AgentRuleInstructionProvider, () => {
  it('discovers native rules, expands authorized references, and derives a composite revision', async () => {
    const { root, workspace } = await fixture();
    await writeFile(join(root, 'docs.md'), 'Shared guidance.');
    await writeFile(
      join(root, '.glyph', 'rules', 'typescript.mdc'),
      '---\nname: TypeScript\nactivation: file_pattern\nglobs: ["**/*.ts"]\nreferences: [docs.md]\n---\nUse strict types.',
    );
    const provider = new AgentRuleInstructionProvider(workspace, {
      kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      directory: '.glyph',
    });

    const [rule] = await provider.discover();
    expect(rule).toMatchObject({
      id: 'glyph_project_rule:.glyph/rules/typescript.mdc',
      name: 'TypeScript',
      scope: '.',
      status: AgentInstructionSourceStatus.ACTIVE,
      activation: AgentInstructionActivationMode.FILE_PATTERN,
      globs: ['**/*.ts'],
      references: ['docs.md'],
    });
    expect(rule?.content).toContain('Use strict types.');
    expect(rule?.content).toContain('Referenced source (docs.md):\nShared guidance.');
    expect(rule?.revision).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('loads Cursor metadata at nested scope and infers always, file, model, and manual modes', async () => {
    const { root, workspace } = await fixture();
    const directory = join(root, 'packages', 'api', '.cursor', 'rules');
    await Promise.all([
      writeFile(join(directory, 'always.mdc'), '---\nalwaysApply: true\n---\nAlways.'),
      writeFile(join(directory, 'files.mdc'), '---\nglobs: "**/*.ts"\n---\nFiles.'),
      writeFile(join(directory, 'model.mdc'), '---\ndescription: Relevant APIs\n---\nModel.'),
      writeFile(join(directory, 'manual.mdc'), 'Manual.'),
    ]);
    const provider = new AgentRuleInstructionProvider(workspace, {
      kind: AgentInstructionSourceKind.CURSOR_PROJECT_RULE,
      directory: '.cursor',
    });

    const rules = await provider.discover();
    expect(rules.map(rule => [rule.name, rule.scope, rule.activation])).toEqual([
      ['always', 'packages/api', AgentInstructionActivationMode.ALWAYS],
      ['files', 'packages/api', AgentInstructionActivationMode.FILE_PATTERN],
      ['manual', 'packages/api', AgentInstructionActivationMode.MANUAL],
      ['model', 'packages/api', AgentInstructionActivationMode.MODEL],
    ]);
  });

  it('reports malformed metadata, missing references, circular references, and discovery limits', async () => {
    const { root, workspace } = await fixture();
    await Promise.all([
      writeFile(join(root, '.glyph', 'rules', 'broken.mdc'), '---\nglobs: [../bad]\n---\nBroken.'),
      writeFile(join(root, '.glyph', 'rules', 'missing.mdc'), '---\nreferences: [missing.md]\n---\nMissing.'),
      writeFile(join(root, '.glyph', 'rules', 'cycle.mdc'), '---\nreferences: [.glyph/rules/cycle.mdc]\n---\nCycle.'),
    ]);
    const provider = new AgentRuleInstructionProvider(workspace, {
      kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      directory: '.glyph',
    });
    const rules = await provider.discover();
    expect(rules).toHaveLength(3);
    expect(rules.every(rule => rule.status === AgentInstructionSourceStatus.ERROR)).toBe(true);
    expect(rules.map(rule => rule.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Invalid rule glob'),
        expect.stringContaining('Circular rule reference'),
        expect.stringContaining('Missing rule reference'),
      ]),
    );

    const limited = new AgentRuleInstructionProvider(
      workspace,
      { kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE, directory: '.glyph', maxFiles: 1 },
      async () => ({ files: [], truncated: true }),
    );
    expect((await limited.discover()).at(-1)).toMatchObject({
      status: AgentInstructionSourceStatus.ERROR,
      message: 'Rule discovery exceeded the 1-file limit.',
    });
  });

  it('qualifies user rule display paths and direct source URIs', async () => {
    const { root, workspace } = await fixture();
    await writeFile(join(root, '.glyph', 'rules', 'user.mdc'), 'User rule.');
    const provider = new AgentRuleInstructionProvider(workspace, {
      kind: AgentInstructionSourceKind.GLYPH_USER_RULE,
      directory: '.glyph',
      displayPrefix: '~/',
      uriForPath: path => `file:///home/test/${path}`,
    });

    expect((await provider.discover())[0]).toMatchObject({
      path: '~/.glyph/rules/user.mdc',
      uri: 'file:///home/test/.glyph/rules/user.mdc',
      activation: AgentInstructionActivationMode.MANUAL,
    });
  });

  it('reports discovery failures, filters nested user paths, and uses fallback errors', async () => {
    const workspace = {
      normalizePath: (path: string) => path,
      read: vi.fn().mockRejectedValue('untyped read failure'),
    } as unknown as FileSystemWorkspaceTextStore;
    const discovery = new AgentRuleInstructionProvider(
      workspace,
      { kind: AgentInstructionSourceKind.GLYPH_USER_RULE, directory: '.', displayPrefix: '~/.glyph/' },
      async () => {
        throw 'untyped discovery failure';
      },
    );
    await expect(discovery.discover()).resolves.toEqual([
      expect.objectContaining({ message: 'Rules could not be discovered.' }),
    ]);

    const read = new AgentRuleInstructionProvider(
      workspace,
      { kind: AgentInstructionSourceKind.GLYPH_USER_RULE, directory: '.' },
      async () => ({ files: ['rules/direct.mdc', 'nested/rules/ignored.mdc'], truncated: false }),
    );
    await expect(read.discover()).resolves.toEqual([
      expect.objectContaining({ path: 'rules/direct.mdc', message: 'Rule could not be read.' }),
    ]);

    const withUri = new AgentRuleInstructionProvider(
      workspace,
      {
        kind: AgentInstructionSourceKind.GLYPH_USER_RULE,
        directory: '.',
        uriForPath: path => `file:///rules/${path}`,
      },
      async () => ({ files: ['rules/direct.mdc'], truncated: false }),
    );
    await expect(withUri.discover()).resolves.toEqual([
      expect.objectContaining({ uri: 'file:///rules/rules/direct.mdc' }),
    ]);
  });

  it('propagates cancellation while reading and expanding references', async () => {
    for (const phase of ['read', 'reference'] as const) {
      const controller = new AbortController();
      const cancelled = new Error(`cancelled ${phase}`);
      const workspace = {
        normalizePath: (path: string) => path,
        read: vi.fn(async () => {
          if (phase === 'read') controller.abort(cancelled);
          return { text: '---\nreferences: [docs.md]\n---\nBody', revision: 'one' };
        }),
        readOptional: vi.fn(async () => {
          controller.abort(cancelled);
          throw new Error('reference stopped');
        }),
      } as unknown as FileSystemWorkspaceTextStore;
      const provider = new AgentRuleInstructionProvider(
        workspace,
        { kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE, directory: '.glyph' },
        async () => ({ files: ['.glyph/rules/test.mdc'], truncated: false }),
      );
      await expect(provider.discover(controller.signal)).rejects.toBe(cancelled);
    }
  });

  it('rejects paths outside their configured rule root and excessive reference depth', async () => {
    const outside = new AgentRuleInstructionProvider(
      { normalizePath: (path: string) => path } as never,
      { kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE, directory: '.glyph' },
      async () => ({ files: ['outside.mdc'], truncated: false }),
    );
    await expect(outside.discover()).rejects.toThrow('outside .glyph/rules');

    const workspace = {
      normalizePath: (path: string) => path,
      read: vi.fn(async () => ({ text: '---\nreferences: [ref-0.mdc]\n---\nRoot', revision: 'root' })),
      readOptional: vi.fn(async (path: string) => {
        const index = Number(/ref-(\d+)/u.exec(path)?.[1] ?? 0);
        return {
          text: `---\nreferences: [ref-${index + 1}.mdc]\n---\n${index}`,
          revision: String(index),
        };
      }),
    } as unknown as FileSystemWorkspaceTextStore;
    const deep = new AgentRuleInstructionProvider(
      workspace,
      { kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE, directory: '.glyph' },
      async () => ({ files: ['.glyph/rules/deep.mdc'], truncated: false }),
    );
    await expect(deep.discover()).resolves.toEqual([
      expect.objectContaining({
        status: AgentInstructionSourceStatus.ERROR,
        message: expect.stringContaining('16 levels'),
      }),
    ]);
  });

  it('labels every supported source family and resolves synthetic root-prefixed paths', async () => {
    const workspace = {
      normalizePath: (path: string) => path,
      read: vi.fn(async () => ({ text: 'Body', revision: 'one' })),
      readOptional: vi.fn(),
    } as unknown as FileSystemWorkspaceTextStore;
    const variants = [
      [AgentInstructionSourceKind.GLYPH_PROJECT_RULE, 'Glyph project rule'],
      [AgentInstructionSourceKind.GLYPH_USER_RULE, 'Glyph user rule'],
      [AgentInstructionSourceKind.CURSOR_PROJECT_RULE, 'Cursor-compatible rule'],
      [AgentInstructionSourceKind.AGENTS_MD, 'AGENTS.md'],
    ] as const;
    for (const [kind, expected] of variants) {
      const provider = new AgentRuleInstructionProvider(
        workspace,
        { kind: kind as never, directory: '.glyph' },
        async () => ({ files: ['/.glyph/rules/root.mdc'], truncated: false }),
      );
      expect((await provider.discover())[0]).toMatchObject({ label: expected, scope: '.' });
    }

    const invalid = new AgentRuleInstructionProvider(
      workspace,
      { kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE, directory: '.glyph' },
      async () => ({ files: ['rules/not-glyph.mdc'], truncated: false }),
    );
    await expect(invalid.discover()).rejects.toThrow('outside .glyph/rules');
  });

  it('uses the default discovery limit and resolves references relative to nested rule scope', async () => {
    const workspace = {
      normalizePath: (path: string) => path,
      read: vi.fn(async () => ({
        text: '---\nreferences: [docs.md]\n---\nNested',
        revision: 'one',
      })),
      readOptional: vi.fn(async () => ({ text: 'Docs', revision: 'two' })),
    } as unknown as FileSystemWorkspaceTextStore;
    const provider = new AgentRuleInstructionProvider(
      workspace,
      { kind: AgentInstructionSourceKind.CURSOR_PROJECT_RULE, directory: '.cursor' },
      async (maxFiles, pattern) => {
        expect(maxFiles).toBe(10_000);
        expect(pattern).toBe('**/.cursor/rules/*.mdc');
        return { files: ['packages/api/.cursor/rules/test.mdc'], truncated: true };
      },
    );

    const discovered = await provider.discover();
    expect(workspace.readOptional).toHaveBeenCalledWith('packages/api/docs.md', { maxBytes: 64 * 1024 });
    expect(discovered).toEqual([
      expect.objectContaining({ scope: 'packages/api', references: ['packages/api/docs.md'] }),
      expect.objectContaining({ message: 'Rule discovery exceeded the 10000-file limit.' }),
    ]);
  });
});
