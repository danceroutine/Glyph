import { testPackageMutations } from './fixtures/testPackageMutations.ts';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import type { ShellProgram } from '#src/shell/ShellProgram.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SkillPackageDraft } from '#src/skills/SkillPackageDraft.js';
import { SkillStateStore } from '#src/skills/SkillStateStore.js';
import { SkillScriptRunner } from '#src/skills/SkillScriptRunner.js';
import { SkillChangeApprovalPolicy } from '#src/skills/SkillChangeApprovalPolicy.js';
import { Approval } from '#src/interaction/approvals/Approval.js';
import { aSkillPackage, aSkillDescriptor } from './fixtures/aSkillDescriptor.ts';

const draftInput = {
  name: 'example',
  source: 'fixture',
  files: [
    { path: 'SKILL.md', content: '---\nname: example\ndescription: Example\n---\nBody', encoding: 'utf8' as const },
  ],
};
describe(SkillPackageDraft, () => {
  it('validates metadata, preserves immutable bytes, and binds the revision to every resource', () => {
    const draft = new SkillPackageDraft(draftInput);
    const copied = draft.files();
    copied.get('SKILL.md')?.fill(0);
    expect(draft.toJSON().files[0]?.content).toBe(Buffer.from(draftInput.files[0]!.content).toString('base64'));
    expect(new SkillPackageDraft(draft.toJSON()).revision).toBe(draft.revision);
    expect(
      new SkillPackageDraft({
        ...draftInput,
        files: [...draftInput.files, { path: 'extra', content: 'new', encoding: 'utf8' }],
      }).revision,
    ).not.toBe(draft.revision);
  });
  it.each(['../escape', '/absolute', 'a/../b', 'a//b', 'a\\b', 'a:drive'])('rejects invalid package path %s', path => {
    expect(
      () =>
        new SkillPackageDraft({
          ...draftInput,
          files: [...draftInput.files, { path, content: 'bad', encoding: 'utf8' }],
        }),
    ).toThrow();
  });
  it('bounds aggregate package bytes and rejects malformed manifest encodings', () => {
    expect(
      () =>
        new SkillPackageDraft({
          ...draftInput,
          files: [
            ...draftInput.files,
            ...Array.from({ length: 9 }, (_, i) => ({
              path: `asset-${i}`,
              content: 'x'.repeat(1024 * 1024),
              encoding: 'utf8' as const,
            })),
          ],
        }),
    ).toThrow('budget');
    expect(
      () =>
        new SkillPackageDraft({ ...draftInput, files: [{ path: 'SKILL.md', content: '/w==', encoding: 'base64' }] }),
    ).toThrow();
  });
  it('rejects duplicate paths, missing metadata, invalid base64, and excessive bytes', () => {
    expect(() => new SkillPackageDraft({ ...draftInput, files: [...draftInput.files, ...draftInput.files] })).toThrow(
      'collide',
    );
    expect(
      () => new SkillPackageDraft({ ...draftInput, files: [{ path: 'readme', content: 'missing', encoding: 'utf8' }] }),
    ).toThrow('missing SKILL.md');
    expect(
      () =>
        new SkillPackageDraft({
          ...draftInput,
          files: [...draftInput.files, { path: 'bad', content: '%%%%', encoding: 'base64' }],
        }),
    ).toThrow('base64');
    expect(
      () =>
        new SkillPackageDraft({
          ...draftInput,
          files: [...draftInput.files, { path: 'big', content: 'x'.repeat(1048577), encoding: 'utf8' }],
        }),
    ).toThrow('budget');
  });
});
describe(SkillStateStore, () => {
  it('serializes preference writes, merges disk state, and rolls back memory after a write failure', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-skill-state-')));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const store = new FileSystemWorkspaceTextStore(root);
    const first = new SkillStateStore(store.root, testFilesystemMetadata);
    await first.initialize();
    await Promise.all([first.setEnabled('one', false), first.setEnabled('two', true)]);
    const second = new SkillStateStore(store.root, testFilesystemMetadata);
    await second.initialize();
    await second.record('one', 'Repository @ pinned SHA', 'version');
    await first.setEnabled('three', true);
    expect(first.installations.get('one')?.revision).toBe('version');
    vi.spyOn(first.preferences, 'replace').mockRejectedValueOnce(new Error('Unavailable storage'));
    await expect(first.setEnabled('one', true)).rejects.toThrow('Unavailable');
    expect(first.enabled.get('one')).toBe(false);
    expect(JSON.parse(await readFile(join(root, 'skill-state.json'), 'utf8'))).toMatchObject({
      enabled: { one: false },
    });
  });
});
describe(SkillChangeApprovalPolicy, () => {
  it('has only one-shot allow/deny choices, with no reusable permission grants', () => {
    const policy = new SkillChangeApprovalPolicy();
    const approval = new Approval(
      policy.createRequest({
        workspace: { workspaceId: 'project', mutationScope: 'project' },
        operation: { title: 'Install example?', detail: 'Reviewed bytes', revision: 'pinned' },
      }),
    );
    expect(policy.matchGrant()).toBeNull();
    approval.markDisplayed();
    const allowed = approval.select('allow_once', 'user');
    expect(policy.planDecision(approval, allowed)).toMatchObject({ disposition: 'allow', grant: null });
    const denied = new Approval(approval.request);
    denied.markDisplayed();
    expect(policy.planDecision(denied, denied.select('deny', 'user'))).toEqual({ disposition: 'deny', grant: null });
  });
});
describe(SkillScriptRunner, () => {
  it('stages the pinned script and binary assets, delegates shell authority and cancellation, then cleans up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyph-skill-runner-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const script = Buffer.from('echo pinned');
    const skill = aSkillPackage(aSkillDescriptor({ allowedTools: ['shell'] }), 'Run script', {
      'scripts/task.sh': script,
      'assets/data': Buffer.from([0, 255]),
    });
    const signal = new AbortController().signal;
    const execute = vi.fn(
      async (
        program: ShellProgram,
        options: { signal: AbortSignal; ownerChatId?: string; workingDirectory?: string },
      ) => {
        expect(options).toMatchObject({ signal, ownerChatId: 'chat', workingDirectory: 'project' });
        expect(program.description).toContain('echo pinned');
        expect(program.description).not.toContain('echo changed');
        return { terminalId: 'terminal', status: 'completed' as const, exitCode: 0, output: 'pinned' };
      },
    );
    script.fill(0);
    const runner = new SkillScriptRunner(
      { executeProgram: execute },
      [{ id: 'project', label: 'Project', directory: root, workingDirectory: 'project', originIds: ['project'] }],
      testFilesystemMetadata,
      async physicalRoot => testPackageMutations(physicalRoot),
    );
    expect(await runner.run(skill, 'scripts/task.sh', ["argument'with quote"], 'chat', signal)).toMatchObject({
      packageRevision: skill.revision,
      output: 'pinned',
      workflowCompleted: false,
    });
    expect(execute).toHaveBeenCalledOnce();
    const program = execute.mock.calls[0]![0];
    expect(program.description).toContain('# Interpreter: /');
    expect(program.arguments[1]).toBe("argument'with quote");
    await expect(readFile(program.arguments[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects undeclared execution, missing resources, traversal, binary scripts, and unsupported interpreters', async () => {
    const execute = vi.fn();
    const runner = new SkillScriptRunner({ executeProgram: execute }, [], testFilesystemMetadata, async root =>
      testPackageMutations(root),
    );
    const signal = new AbortController().signal;
    const skill = aSkillPackage(aSkillDescriptor({ allowedTools: ['project.read_file'] }), 'Body', {
      'scripts/task.sh': Buffer.from('echo nope'),
    });
    await expect(runner.run(skill, 'scripts/task.sh', [], 'chat', signal)).rejects.toThrow('does not declare');
    await expect(runner.run(skill, 'outside.sh', [], 'chat', signal)).rejects.toThrow('scripts/');
    const resource = aSkillPackage(undefined, undefined, {
      'scripts/blob.sh': Buffer.from([0, 255]),
      'scripts/task.exe': Buffer.from('no'),
    });
    await expect(runner.run(resource, 'scripts/../escape', [], 'chat', signal)).rejects.toThrow('inside');
    await expect(runner.run(resource, 'scripts/missing.sh', [], 'chat', signal)).rejects.toThrow('missing');
    await expect(runner.run(resource, 'scripts/blob.sh', [], 'chat', signal)).rejects.toThrow('UTF-8');
    await expect(runner.run(resource, 'scripts/task.exe', [], 'chat', signal)).rejects.toThrow('Supported');
    expect(execute).not.toHaveBeenCalled();
  });
});

it('rejects malformed paths in a pinned package before running a script and cleans failed staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glyph-skill-stage-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const execute = vi.fn();
  const runner = new SkillScriptRunner(
    { executeProgram: execute },
    [{ id: 'project', label: 'Project', directory: root, workingDirectory: '.', originIds: ['project'] }],
    testFilesystemMetadata,
    async physicalRoot => testPackageMutations(physicalRoot),
  );
  const skill = aSkillPackage(undefined, undefined, {
    'scripts/task.sh': Buffer.from('echo valid'),
    '../escape': Buffer.from('invalid'),
  });
  await expect(runner.run(skill, 'scripts/task.sh', [], 'chat', new AbortController().signal)).rejects.toThrow(
    'invalid resource',
  );
  expect(execute).not.toHaveBeenCalled();
});

it('retains installed package metadata in serialized descriptors', async () => {
  const { skillDescriptorSchema } = await import('#src/skills/SkillSchemas.js');
  expect(
    skillDescriptorSchema.parse(
      aSkillDescriptor({ installedFrom: 'Repository @ pinned commit', packageRevision: 'package-version' }),
    ),
  ).toMatchObject({ installedFrom: 'Repository @ pinned commit', packageRevision: 'package-version' });
});

it('runs supported Python and Node scripts with visible compatibility guidance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glyph-skill-interpreters-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const execute = vi.fn(async () => ({
    terminalId: 'shell',
    status: 'completed' as const,
    exitCode: 127,
    output: 'Interpreter unavailable',
  }));
  const runner = new SkillScriptRunner(
    { executeProgram: execute },
    [{ id: 'project', label: 'Project', directory: root, workingDirectory: '.', originIds: ['project'] }],
    testFilesystemMetadata,
    async physicalRoot => testPackageMutations(physicalRoot),
  );
  const skill = aSkillPackage(aSkillDescriptor({ compatibility: 'Requires Python or Node' }), 'Body', {
    'scripts/task.py': Buffer.from('print("hello")'),
    'scripts/task.js': Buffer.from('console.log("hello")'),
  });
  for (const path of ['scripts/task.py', 'scripts/task.js'])
    expect(await runner.run(skill, path, [], 'chat', new AbortController().signal)).toMatchObject({
      exitCode: 127,
      compatibility: 'Requires Python or Node',
      workflowCompleted: false,
    });
});

it('reports invalid package input with actionable author-facing messages', () => {
  expect(() => new SkillPackageDraft({ ...draftInput, name: 'Invalid Name' })).toThrow('lowercase');
  expect(() => new SkillPackageDraft(null)).toThrow('complete package');
});
