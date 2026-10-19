import { AgentMode } from '#src/chat/AgentMode.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import type { Tool } from '#src/tools/Tool.js';
import { z } from 'zod';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import type { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import type { ToolSource } from '#src/tools/ToolSource.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import type { Logger } from '#src/observability/Logger.js';
import { NullLogger } from '#src/observability/NullLogger.js';
import type { ProjectAccess } from './ProjectAccess.ts';
import { ProjectToolName } from './ProjectToolName.ts';
import { ProjectToolNamespace } from './ProjectToolNamespace.ts';
import type { ToolExecutionContext } from '#src/tools/ToolExecutionContext.js';

export class ProjectToolRuntime implements ToolSource {
  private readonly logger: Logger;

  constructor(
    private readonly access: ProjectAccess,
    private readonly proposals: EditProposalService,
    private readonly reviews: ProposalReviewManager,
    logger: Logger = new NullLogger(),
  ) {
    this.logger = logger.forNamespace('project.tool');
  }

  get tools(): readonly Tool[] {
    return [
      ...this.access.tools,
      {
        namespace: ProjectToolNamespace.PROJECT,
        name: ProjectToolName.PROPOSE_PATCH,
        allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
        description: `Stage a strict patch for user review. Prefer this for ordinary source edits. The grammar is:
*** Begin Patch
*** Add File: path
+new line
*** Update File: path
*** Revision: <revision returned by read_project_file>
[*** Move to: new/path]
[*** Byte Order Mark: true|false]
[*** Line Ending: LF|CRLF|CR]
@@
 exact context
-removed line
+added line
*** Delete File: path
*** Revision: <revision>
[\\ No newline at end of file]
*** End Patch
Every directive and context line is exact; no fuzzy matching occurs. Never claim the workspace changed until the user accepts review items.`,
        inputKind: ToolInputKind.TEXT,
        validateInput: input => {
          if (!input.trim()) throw new Error('Expected a nonempty patch.');
        },
        execute: (input, signal, context) => this.execute(ProjectToolName.PROPOSE_PATCH, input, signal, context),
      },
      {
        namespace: ProjectToolNamespace.PROJECT,
        name: ProjectToolName.PROPOSE_EDITS,
        allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
        description:
          'Stage exact UTF-16 range edits for user review. Use for whitespace, line-ending, or Unicode-sensitive changes.',
        inputKind: ToolInputKind.JSON,
        parameters: toJsonSchema(EditProposalService.structuredSchema),
        validateInput: input => {
          EditProposalService.structuredSchema.parse(JSON.parse(input));
        },
        execute: (input, signal, context) => this.execute(ProjectToolName.PROPOSE_EDITS, input, signal, context),
      },
    ];
  }

  async execute(name: string, input: string, signal?: AbortSignal, context?: ToolExecutionContext): Promise<string> {
    try {
      signal?.throwIfAborted();
      await this.logger.debug('ingested', { name, inputBytes: Buffer.byteLength(input) });
      signal?.throwIfAborted();
      let proposal;
      switch (name) {
        case ProjectToolName.LIST_FILES:
        case ProjectToolName.READ_FILE:
        case ProjectToolName.SEARCH_CONTENTS:
          return this.access.execute(name, input, signal);
        case ProjectToolName.PROPOSE_PATCH:
          proposal = await this.proposals.proposePatch(input, signal);
          break;
        case ProjectToolName.PROPOSE_EDITS:
          proposal = await this.proposals.proposeStructured(
            EditProposalService.structuredSchema.parse(JSON.parse(input)),
            signal,
          );
          break;
        default:
          throw new Error(`Unknown project tool: ${name}`);
      }
      await this.proposals.assertModeAllows(proposal, AgentMode.resolve(context?.mode ?? AgentMode.default.id));
      const stagedProposal = context?.chat
        ? {
            ...proposal,
            origin: {
              chatId: context.chat.id,
              accountProvider: context.chat.accountProvider,
              accountId: context.chat.accountId,
            },
          }
        : proposal;
      // Compilation does not change durable state, so cancellation may still
      // discard it. Once staging starts, finish persistence and return its real
      // result rather than reporting a cancellation that hides a saved review.
      signal?.throwIfAborted();
      await this.reviews.stage(stagedProposal);
      const queuePosition = this.reviews.activeReviews.findIndex(review => review.id === stagedProposal.id) + 1;
      return JSON.stringify({
        proposal_id: proposal.id,
        status: stagedProposal.files.some(file => file.automatic?.state === 'applied')
          ? 'APPLIED_WITH_REVERT'
          : 'STAGED_FOR_REVIEW',
        queue_position: queuePosition,
        active_reviews: this.reviews.activeReviews.length,
        files: proposal.files.length,
        review_items: proposal.files.reduce((sum, file) => sum + file.items.length, 0),
        message: stagedProposal.files.some(file => file.automatic?.state === 'applied')
          ? 'Structural file changes have been applied. The user can inspect and revert them in the review drawer. Any text hunks still pending require acceptance.'
          : 'The proposal was appended to the review queue, but no workspace changes have been written. The user must accept review items.',
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      await this.logger.error('failed', {
        name,
        error:
          error instanceof EditError
            ? error.toJSON()
            : { message: error instanceof Error ? error.message : String(error) },
      });
      return JSON.stringify({
        error:
          error instanceof EditError
            ? error.toJSON()
            : { code: 'TOOL_FAILED', message: error instanceof Error ? error.message : 'Project tool failed.' },
      });
    }
  }
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema, { target: 'draft-7' });
  return parameters;
}
