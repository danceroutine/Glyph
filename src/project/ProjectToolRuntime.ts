import { z } from 'zod';
import { EditError } from '../editing/EditError.ts';
import { EditProposalService } from '../editing/EditProposalService.ts';
import type { EditSessionManager } from '../editing/EditSessionManager.ts';
import type { ToolRuntime } from '../tools/ToolRuntime.ts';
import type { ToolDefinition } from '../tools/ToolDefinition.ts';
import { ToolInputKind } from '../tools/ToolInputKind.ts';
import type { Logger } from '../observability/Logger.ts';
import { NullLogger } from '../observability/NullLogger.ts';
import type { ProjectAccess } from './ProjectAccess.ts';
import { ProjectToolName } from './ProjectToolName.ts';
import { ProjectToolNamespace } from './ProjectToolNamespace.ts';

const editDefinitions: readonly ToolDefinition[] = [
  {
    namespace: ProjectToolNamespace.PROJECT,
    name: ProjectToolName.PROPOSE_PATCH,
    description: `Stage a strict patch for user review. Prefer this for ordinary source edits. The grammar is:
*** Begin Patch
*** Add File: path
+new line
*** Update File: path
*** Revision: <revision returned by read_project_file>
[*** Move to: new/path]
[*** BOM: true|false]
[*** EOL: LF|CRLF|CR]
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
  },
  {
    namespace: ProjectToolNamespace.PROJECT,
    name: ProjectToolName.PROPOSE_EDITS,
    description: 'Stage exact UTF-16 range edits for user review. Use for whitespace, EOL, or Unicode-sensitive changes.',
    inputKind: ToolInputKind.JSON,
    parameters: toJsonSchema(EditProposalService.structuredSchema),
  },
];

export class ProjectToolRuntime implements ToolRuntime {
  readonly definitions: readonly ToolDefinition[];

  constructor(
    private readonly access: ProjectAccess,
    private readonly proposals: EditProposalService,
    private readonly sessions: EditSessionManager,
    private readonly logger: Logger = new NullLogger(),
  ) {
    this.definitions = [...access.definitions, ...editDefinitions];
  }

  async execute(name: string, input: string): Promise<string> {
    try {
      await this.logger.debug('tool.ingested', { name, inputBytes: Buffer.byteLength(input) });
      if (name === ProjectToolName.LIST_FILES || name === ProjectToolName.READ_FILE) return this.access.execute(name, input);
      const proposal = name === ProjectToolName.PROPOSE_PATCH
        ? await this.proposals.proposePatch(input)
        : name === ProjectToolName.PROPOSE_EDITS
          ? await this.proposals.proposeStructured(EditProposalService.structuredSchema.parse(JSON.parse(input)))
          : undefined;
      if (!proposal) throw new Error(`Unknown project tool: ${name}`);
      await this.sessions.stage(proposal);
      return JSON.stringify({
        proposal_id: proposal.id,
        status: 'STAGED_FOR_REVIEW',
        files: proposal.files.length,
        review_items: proposal.files.reduce((sum, file) => sum + file.items.length, 0),
        message: 'The proposal is staged but no workspace changes have been written. The user must accept review items.',
      });
    } catch (error) {
      await this.logger.error('tool.failed', {
        name,
        error: error instanceof EditError
          ? error.toJSON()
          : { message: error instanceof Error ? error.message : String(error) },
      });
      return JSON.stringify({
        error: error instanceof EditError
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
