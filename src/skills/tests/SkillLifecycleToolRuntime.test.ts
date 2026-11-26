import { describe, expect, it, vi } from 'vitest';
import type { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { SkillLifecycleToolRuntime } from '#src/skills/SkillLifecycleToolRuntime.js';
import { SkillTurnContext } from '#src/skills/SkillContextContributor.js';
import { aSkillDescriptor, aSkillPackage } from './fixtures/aSkillDescriptor.ts';

const draft = {
  name: 'example',
  source: 'not trusted',
  files: [{ path: 'SKILL.md', content: '---\nname: example\ndescription: Example\n---\nBody', encoding: 'utf8' }],
};
function fixture(allowed = true) {
  const preview = {
    id: 'preview',
    action: 'install' as const,
    targetId: 'user:glyph',
    name: 'example',
    source: 'Agent proposal',
    revision: 'pinned',
    files: [{ path: 'SKILL.md', after: 'Body' }],
  };
  const manager = {
    targets: [{ id: 'user:glyph', label: 'User' }],
    prepare: vi.fn(async () => preview),
    prepareRemoval: vi.fn(async () => ({ ...preview, action: 'remove' })),
    apply: vi.fn(async () => ({ applied: true })),
    discard: vi.fn(),
    workspacePaths: vi.fn((): readonly string[] => []),
  };
  const approve = vi.fn(async () => allowed);
  const descriptor = aSkillDescriptor();
  const catalog = { capture: vi.fn(async () => aSkillPackage(descriptor)) };
  const session = new SkillTurnContext('turn', [descriptor], [descriptor], catalog as never);
  const turns = { contribution: vi.fn(() => session), disclosePaths: vi.fn<TurnContextCoordinator['disclosePaths']>() };
  const runner = { run: vi.fn(async () => ({ output: 'Done', exitCode: 0 })) };
  const runtime = new SkillLifecycleToolRuntime(manager as never, approve, turns, runner as never);
  const tool = runtime.tools[0]!;
  const script = runtime.tools[1]!;
  const context = {
    turnId: 'turn',
    mode: AgentModeID.AGENT,
    chat: { id: 'chat', accountProvider: 'test', accountId: 'test' },
  };
  const signal = new AbortController().signal;
  return { manager, approve, turns, runner, session, tool, script, context, signal };
}
describe(SkillLifecycleToolRuntime, () => {
  it('advertises a strict object schema with every nullable script field required', () => {
    const { script } = fixture();
    expect(script.parameters).toMatchObject({
      additionalProperties: false,
      required: ['id', 'path', 'args', 'workspace_root_id'],
    });
  });
  it.each([true, false])('applies exactly the approved revision when authorization is %s', async allowed => {
    const { manager, approve, turns, tool, context, signal } = fixture(allowed);
    const input = JSON.stringify({ target_id: 'user:glyph', replace_id: null, remove_id: null, draft });
    tool.validateInput(input);
    const output = JSON.parse(await tool.execute(input, signal, context));
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ revision: 'pinned' }), signal);
    expect(output).toMatchObject({ applied: allowed });
    expect(turns.disclosePaths).not.toHaveBeenCalled();
    expect(manager.apply).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(manager.discard).toHaveBeenCalledWith('preview');
  });
  it('discloses newly applicable package instructions before approval and admits the regenerated proposal', async () => {
    const { manager, approve, tool, context, turns, signal } = fixture();
    const paths = ['two/.glyph/skills/example/SKILL.md', 'two/.glyph/skills/example/assets/icon.bin'];
    manager.workspacePaths.mockReturnValue(paths);
    const instructions = { schema: 'glyph.agent-instructions.v1' as const, sources: [] };
    turns.disclosePaths.mockReturnValueOnce(instructions);
    const input = JSON.stringify({
      target_id: 'user:glyph',
      replace_id: null,
      remove_id: 'installed-project-skill',
      draft: null,
    });
    const first = await tool.execute(input, signal, context);
    expect(JSON.parse(first)).toMatchObject({
      status: 'INSTRUCTION_CONTEXT_REQUIRED',
      instructionContext: instructions,
    });
    expect(turns.disclosePaths).toHaveBeenCalledWith(context.turnId, paths);
    expect(manager.workspacePaths).toHaveBeenCalledWith('preview');
    expect(tool.activityPresentation?.show(first)).toBe(false);
    expect(approve).not.toHaveBeenCalled();
    expect(manager.apply).not.toHaveBeenCalled();
    expect(manager.discard).toHaveBeenCalledWith('preview');
    const final = await tool.execute(input, signal, context);
    expect(JSON.parse(final)).toMatchObject({ applied: true });
    expect(tool.activityPresentation?.show(final)).toBe(true);
    expect(approve).toHaveBeenCalledOnce();
    expect(manager.apply).toHaveBeenCalledOnce();
    expect(manager.discard).toHaveBeenCalledTimes(2);
  });
  it('discards the pending preview if instruction disclosure fails before review', async () => {
    const { manager, approve, turns, tool, context, signal } = fixture();
    manager.workspacePaths.mockReturnValue(['src/.glyph/skills/example/SKILL.md']);
    turns.disclosePaths.mockImplementation(() => {
      throw new Error('Instruction catalog changed');
    });
    const input = JSON.stringify({ target_id: 'project', replace_id: null, remove_id: null, draft });
    await expect(tool.execute(input, signal, context)).rejects.toThrow('Instruction catalog changed');
    expect(manager.discard).toHaveBeenCalledWith('preview');
    expect(approve).not.toHaveBeenCalled();
    expect(manager.apply).not.toHaveBeenCalled();
  });
  it('requires a turn, validates exclusive actions, and discards a cancelled proposal without mutation', async () => {
    const { manager, approve, tool, context, signal } = fixture();
    const input = JSON.stringify({ target_id: 'user:glyph', replace_id: null, remove_id: 'existing', draft: null });
    await expect(tool.execute(input, signal, {})).rejects.toThrow('owning');
    await expect(
      tool.execute(
        JSON.stringify({ target_id: 'user:glyph', replace_id: null, remove_id: null, draft: null }),
        signal,
        context,
      ),
    ).rejects.toThrow('Choose');
    approve.mockRejectedValueOnce(new Error('Cancelled'));
    await expect(tool.execute(input, signal, context)).rejects.toThrow('Cancelled');
    expect(manager.prepareRemoval).toHaveBeenCalledWith('existing');
    expect(manager.apply).not.toHaveBeenCalled();
    expect(manager.discard).toHaveBeenCalled();
  });
  it('delegates scripts from an active pinned package and rejects missing turn authority', async () => {
    const { script, context, signal, runner, session, turns } = fixture();
    const input = JSON.stringify({ id: 'project:example', path: 'scripts/task.sh', args: [] });
    script.validateInput(input);
    await expect(script.execute(input, signal, {})).rejects.toThrow('owning');
    await expect(script.execute(input, signal, context)).rejects.toThrow('Activate');
    await session.activateSource('project:example', 'manual', 'User selection');
    expect(JSON.parse(await script.execute(input, signal, context))).toMatchObject({ output: 'Done' });
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ descriptor: expect.objectContaining({ id: 'project:example' }) }),
      'scripts/task.sh',
      [],
      'chat',
      signal,
      undefined,
    );
    session.release();
    await expect(script.execute(input, signal, context)).rejects.toThrow('ended');
    turns.contribution.mockReturnValueOnce(undefined as never);
    await expect(script.execute(input, signal, context)).rejects.toThrow('unavailable');
  });
});

it('propagates cancellation before applying a skill proposal', async () => {
  const { manager, tool, context } = fixture();
  const controller = new AbortController();
  controller.abort(new Error('Cancelled skill proposal'));
  await expect(
    tool.execute(
      JSON.stringify({ target_id: 'user:glyph', replace_id: null, remove_id: null, draft }),
      controller.signal,
      context,
    ),
  ).rejects.toThrow('Cancelled skill proposal');
  expect(manager.apply).not.toHaveBeenCalled();
});

it('preserves failed script exit status and process output as a failed tool operation', async () => {
  const { script, context, signal, runner, session } = fixture();
  await session.activateSource('project:example', 'manual', 'Selected');
  runner.run.mockResolvedValueOnce({ exitCode: 7, output: 'Failed process output' });
  await expect(
    script.execute(
      JSON.stringify({ id: 'project:example', path: 'scripts/task.sh', args: [], workspace_root_id: 'second' }),
      signal,
      context,
    ),
  ).rejects.toMatchObject({
    code: 'SKILL_SCRIPT_FAILED',
    output: JSON.stringify({ exitCode: 7, output: 'Failed process output' }),
  });
  expect(runner.run).toHaveBeenCalledWith(expect.anything(), 'scripts/task.sh', [], 'chat', signal, 'second');
});
