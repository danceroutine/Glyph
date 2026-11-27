import { ToolOperationError } from '#src/tools/ToolOperationError.js';
import { skillToolFailure } from './SkillToolFailure.ts';
import { z } from 'zod';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import type { ToolSource } from '#src/tools/ToolSource.js';
import type { Tool } from '#src/tools/Tool.js';
import {
  proposalActivityPresentation,
  proposalInstructionContext,
} from '#src/context/turns/proposalInstructionContext.js';
import type { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';
import type { SkillPackageManager } from './SkillPackageManager.ts';
import { SkillPackageDraft, skillPackageDraftSchema } from './SkillPackageDraft.ts';
import type { SkillPreview } from './SkillLifecycle.ts';
import type { SkillScriptRunner } from './SkillScriptRunner.ts';
import { acquireActiveSkillPackage } from './activeSkillPackage.ts';

const changeSchema = z
  .object({
    target_id: z.string().min(1),
    replace_id: z.string().nullable(),
    remove_id: z.string().nullable(),
    draft: skillPackageDraftSchema.partial({ directories: true }).nullable(),
  })
  .strict();
const runSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    args: z.array(z.string().max(1000)).max(32),
    workspace_root_id: z.string().min(1).nullish(),
  })
  .strict();
/** Human-reviewed package proposals and sandboxed execution share existing tool and interaction lifetimes. */
export class SkillLifecycleToolRuntime implements ToolSource {
  readonly tools: readonly Tool[];
  constructor(
    manager: SkillPackageManager,
    approve: (preview: SkillPreview, signal: AbortSignal) => Promise<boolean>,
    turns: Pick<TurnContextCoordinator, 'contribution' | 'disclosePaths'>,
    runner: SkillScriptRunner,
  ) {
    this.tools = [
      {
        namespace: 'skills',
        name: 'propose_change',
        requiresExclusiveRound: true,
        activityPresentation: proposalActivityPresentation,
        allowedModes: [AgentModeID.AGENT],
        inputKind: ToolInputKind.JSON,
        description: `Propose a complete skill package installation/update or removal. The human reviews files and directories before they change. Native targets: ${JSON.stringify(manager.targets.slice(0, 32).map(({ id, label, updateOnly }) => ({ id, label, updateOnly })))}. Set unused nullable fields to null. Draft files and directories replace the complete package. List empty directory paths explicitly.`,
        parameters: parameters(changeSchema.extend({ draft: skillPackageDraftSchema.nullable() })),
        validateInput: input => {
          changeSchema.parse(JSON.parse(input));
        },
        execute: async (input, signal, context) => {
          if (!context.chat || !context.turnId) throw new Error('Skill changes require an owning agent turn.');
          const change = changeSchema.parse(JSON.parse(input));
          if (Boolean(change.remove_id) === Boolean(change.draft))
            throw new Error('Choose a package draft or a removal.');
          const preview = change.remove_id
            ? await manager.prepareRemoval(change.remove_id, signal)
            : await manager.prepare(
                change.target_id,
                new SkillPackageDraft({ ...change.draft!, source: 'Agent-proposed package' }),
                change.replace_id ?? undefined,
                signal,
              );
          try {
            signal.throwIfAborted();
            const paths = manager.workspacePaths(preview.id);
            const instructionContext =
              paths.length > 0 ? await turns.disclosePaths(context.turnId, paths, signal) : undefined;
            if (instructionContext) return proposalInstructionContext(instructionContext);
            if (!(await approve(preview, signal))) return JSON.stringify({ applied: false, denied: true });
            signal.throwIfAborted();
            const result = await manager.apply(preview.id, signal);
            return JSON.stringify({
              ...result,
              name: preview.name,
              revision: preview.revision,
              action: preview.action,
            });
          } finally {
            manager.discard(preview.id);
          }
        },
      },
      {
        namespace: 'skills',
        name: 'run_script',
        allowedModes: [AgentModeID.AGENT],
        inputKind: ToolInputKind.JSON,
        description: `Run a script from an activated, pinned skill package with one-shot shell approval. For user skills in multi-root workspaces select workspace_root_id from ${JSON.stringify(runner.targets)}. Project scripts run in their owning root. Script declarations never grant permissions. A process finishing does not mean the skill workflow is complete.`,
        parameters: parameters(runSchema.extend({ workspace_root_id: z.string().min(1).nullable() })),
        validateInput: input => {
          runSchema.parse(JSON.parse(input));
        },
        execute: async (input, signal, context) => {
          if (!context.chat || !context.turnId) throw new Error('Skill execution requires an owning agent turn.');
          const request = runSchema.parse(JSON.parse(input));
          const { pinned, assertActive } = acquireActiveSkillPackage(turns, context.turnId, request.id);
          const result = await runner.run(
            pinned,
            request.path,
            request.args,
            context.chat.id,
            signal,
            request.workspace_root_id ?? undefined,
            assertActive,
          );
          const output = JSON.stringify(result);
          if (result.exitCode !== 0)
            throw new ToolOperationError('SKILL_SCRIPT_FAILED', 'The skill process failed.', 'unknown', output);
          return output;
        },
      },
    ];
    this.tools = this.tools.map(tool => ({
      ...tool,
      execute: async (input, signal, context) => {
        try {
          return await tool.execute(input, signal, context);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          throw skillToolFailure(error, 'unknown');
        }
      },
    }));
  }
}
function parameters(schema: z.ZodObject) {
  const { $schema: _, ...value } = z.toJSONSchema(schema, { target: 'draft-7' });
  return value;
}
