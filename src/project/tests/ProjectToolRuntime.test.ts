import { describe, expect, it, vi } from 'vitest';
import type { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { EditProposal } from '#src/editing/proposals/EditProposal.js';
import type { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import type { Logger } from '#src/observability/Logger.js';
import { NullLogger } from '#src/observability/NullLogger.js';
import type { Tool } from '#src/tools/Tool.js';
import type { ProjectAccess } from '#src/project/ProjectAccess.js';
import { ProjectToolName } from '#src/project/ProjectToolName.js';
import { ProjectToolRuntime } from '#src/project/ProjectToolRuntime.js';
import { aFileEditPlan } from '#src/editing/proposals/tests/fixtures/aFileEditPlan.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';

describe(ProjectToolRuntime, () => {
  describe(ProjectToolRuntime.prototype.execute, () => {
    it('captures host-owned chat provenance when staging a proposal', async () => {
      const proposal = EditProposal.from({
        schemaVersion: 1,
        id: 'proposal-1',
        source: 'patch',
        createdAt: new Date(0).toISOString(),
        files: [],
      });
      const activeReviews: EditProposal[] = [];
      const stage = vi.fn(async (staged: EditProposal) => {
        activeReviews.push(staged);
      });
      const runtime = new ProjectToolRuntime(
        { definitions: [] } as unknown as ProjectAccess,
        {
          proposePatch: vi.fn(async () => proposal),
          assertModeAllows: vi.fn(async () => {}),
        } as unknown as EditProposalService,
        { stage, activeReviews } as unknown as ProposalReviewManager,
        new NullLogger(),
      );

      await runtime.execute(ProjectToolName.PROPOSE_PATCH, 'patch', undefined, {
        chat: { id: 'chat-1', accountProvider: 'provider', accountId: 'account-1' },
      });

      expect(stage).toHaveBeenCalledWith({
        ...proposal.toRecord(),
        origin: { chatId: 'chat-1', accountProvider: 'provider', accountId: 'account-1' },
      });
    });

    it.each([ProjectToolName.LIST_FILES, ProjectToolName.READ_FILE, ProjectToolName.SEARCH_CONTENTS])(
      'delegates %s to project access',
      async name => {
        const execute = vi.fn(async () => '{"result":true}');
        const runtime = new ProjectToolRuntime(
          { execute } as unknown as ProjectAccess,
          {} as EditProposalService,
          {} as ProposalReviewManager,
        );
        const signal = new AbortController().signal;

        await expect(runtime.execute(name, '{}', signal)).resolves.toBe('{"result":true}');

        expect(execute).toHaveBeenCalledWith(name, '{}', signal, undefined);
      },
    );

    it('discloses unseen scoped instructions before staging and accepts the regenerated proposal', async () => {
      const proposal = EditProposal.from({
        schemaVersion: 1,
        id: 'proposal-1',
        source: 'patch',
        createdAt: new Date(0).toISOString(),
        files: [
          aFileEditPlan({
            operation: EditOperation.CREATE,
            sourcePath: 'src/new.ts',
            targetPath: 'src/new.ts',
          }),
        ],
      });
      const stage = vi.fn(async () => {});
      const disclosePaths = vi
        .fn()
        .mockReturnValueOnce({
          schema: 'glyph.agent-instructions.v1',
          sources: [{ id: 'nested', path: 'src/AGENTS.md', scope: 'src', status: 'active' }],
        })
        .mockReturnValueOnce(undefined);
      const runtime = new ProjectToolRuntime(
        { definitions: [] } as unknown as ProjectAccess,
        {
          proposePatch: vi.fn(async () => proposal),
          assertModeAllows: vi.fn(async () => {}),
        } as unknown as EditProposalService,
        { stage, activeReviews: [] } as unknown as ProposalReviewManager,
        new NullLogger(),
        { disclosePaths },
      );
      const context = { turnId: 'turn-1' };

      await expect(runtime.execute(ProjectToolName.PROPOSE_PATCH, 'patch', undefined, context)).resolves.toContain(
        'INSTRUCTION_CONTEXT_REQUIRED',
      );
      expect(stage).not.toHaveBeenCalled();
      await runtime.execute(ProjectToolName.PROPOSE_PATCH, 'patch', undefined, context);
      expect(stage).toHaveBeenCalledOnce();
      expect(disclosePaths).toHaveBeenCalledWith('turn-1', ['src/new.ts']);
    });

    it('reports an unknown tool as a failed tool call', async () => {
      const logger = recordingLogger();
      const runtime = new ProjectToolRuntime(
        {} as ProjectAccess,
        {} as EditProposalService,
        {} as ProposalReviewManager,
        logger,
      );

      const result = JSON.parse(await runtime.execute('unknown_tool', '{}'));

      expect(result).toEqual({ error: { code: 'TOOL_FAILED', message: 'Unknown project tool: unknown_tool' } });
      expect(logger.error).toHaveBeenCalledWith('failed', {
        name: 'unknown_tool',
        error: { message: 'Unknown project tool: unknown_tool' },
      });
    });

    it('reports a failure that is not an error object without exposing it to the model', async () => {
      const logger = recordingLogger();
      const runtime = new ProjectToolRuntime(
        {} as ProjectAccess,
        {
          proposePatch: vi.fn(async () => {
            throw 'compiler crashed';
          }),
        } as unknown as EditProposalService,
        {} as ProposalReviewManager,
        logger,
      );

      const result = JSON.parse(await runtime.execute(ProjectToolName.PROPOSE_PATCH, 'patch'));

      expect(result).toEqual({ error: { code: 'TOOL_FAILED', message: 'Project tool failed.' } });
      expect(logger.error).toHaveBeenCalledWith('failed', {
        name: ProjectToolName.PROPOSE_PATCH,
        error: { message: 'compiler crashed' },
      });
    });

    it('rethrows the abort reason when cancellation interrupts a proposal', async () => {
      const controller = new AbortController();
      const reason = new Error('user stopped');
      const runtime = new ProjectToolRuntime(
        {} as ProjectAccess,
        {
          proposePatch: vi.fn(async () => {
            controller.abort(reason);
            throw new Error('compilation interrupted');
          }),
        } as unknown as EditProposalService,
        {} as ProposalReviewManager,
      );

      await expect(runtime.execute(ProjectToolName.PROPOSE_PATCH, 'patch', controller.signal)).rejects.toBe(reason);
    });

    it('rethrows the original failure when an aborted signal carries no reason', async () => {
      let aborted = false;
      const signal = {
        get aborted() {
          return aborted;
        },
        reason: undefined,
        throwIfAborted: () => {},
      } as unknown as AbortSignal;
      const failure = new Error('compilation interrupted');
      const runtime = new ProjectToolRuntime(
        {} as ProjectAccess,
        {
          proposePatch: vi.fn(async () => {
            aborted = true;
            throw failure;
          }),
        } as unknown as EditProposalService,
        {} as ProposalReviewManager,
      );

      await expect(runtime.execute(ProjectToolName.PROPOSE_PATCH, 'patch', signal)).rejects.toBe(failure);
    });
  });

  describe('tools', () => {
    it('extends the project access tools with patch and structured edit proposals', () => {
      const accessTool = { name: ProjectToolName.LIST_FILES } as Tool;
      const runtime = new ProjectToolRuntime(
        { tools: [accessTool] } as unknown as ProjectAccess,
        {} as EditProposalService,
        {} as ProposalReviewManager,
      );

      const tools = runtime.tools;

      expect(tools.map(tool => tool.name)).toEqual([
        ProjectToolName.LIST_FILES,
        ProjectToolName.PROPOSE_PATCH,
        ProjectToolName.PROPOSE_EDITS,
      ]);
      expect(tools[0]).toBe(accessTool);
      expect(tools[2]?.parameters).toMatchObject({ type: 'object', required: ['files'] });
      expect(tools[2]?.parameters).not.toHaveProperty('$schema');
    });

    it('requires a nonempty patch', () => {
      const runtime = new ProjectToolRuntime(
        { tools: [] } as unknown as ProjectAccess,
        {} as EditProposalService,
        {} as ProposalReviewManager,
      );
      const patch = runtime.tools.find(tool => tool.name === (ProjectToolName.PROPOSE_PATCH as string))!;

      expect(() => {
        patch.validateInput(' \n ');
      }).toThrow('Expected a nonempty patch.');
      expect(() => {
        patch.validateInput('*** Begin Patch');
      }).not.toThrow();
    });

    it('requires structured edits that match the proposal schema', () => {
      const runtime = new ProjectToolRuntime(
        { tools: [] } as unknown as ProjectAccess,
        {} as EditProposalService,
        {} as ProposalReviewManager,
      );
      const edits = runtime.tools.find(tool => tool.name === (ProjectToolName.PROPOSE_EDITS as string))!;

      expect(() => {
        edits.validateInput('{"files":[]}');
      }).not.toThrow();
      expect(() => {
        edits.validateInput('{"files":"file.txt"}');
      }).toThrow();
      expect(() => {
        edits.validateInput('not json');
      }).toThrow(SyntaxError);
    });

    it.each([ProjectToolName.PROPOSE_PATCH, ProjectToolName.PROPOSE_EDITS])(
      'executes %s through the runtime with its signal and context',
      async name => {
        const runtime = new ProjectToolRuntime(
          { tools: [] } as unknown as ProjectAccess,
          {} as EditProposalService,
          {} as ProposalReviewManager,
        );
        const execute = vi.spyOn(runtime, 'execute').mockResolvedValue('{"status":"ok"}');
        const tool = runtime.tools.find(candidate => candidate.name === (name as string))!;
        const signal = new AbortController().signal;
        const context = { executionId: 'execution-1' };

        await expect(tool.execute('input', signal, context)).resolves.toBe('{"status":"ok"}');

        expect(execute).toHaveBeenCalledWith(name, 'input', signal, context);
      },
    );
  });
});

function recordingLogger() {
  const logger = {
    forNamespace: (): Logger => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies Logger;
  return logger;
}
