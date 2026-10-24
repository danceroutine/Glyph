import { z } from 'zod';
import { ShellApprovalPolicy } from './ShellApprovalPolicy.ts';
import { ShellPermissionDecision } from './ShellPermissionDecision.ts';
import type { ShellPermissionRequest } from './ShellPermissionRequest.ts';

/** Display metadata comes from the same policy that interprets the decision. */
export function shellPermissionChoices(request: ShellPermissionRequest) {
  const choices =
    request.approval?.request.choices ??
    new ShellApprovalPolicy().createRequest({
      workspace: { workspaceId: 'presentation', mutationScope: 'presentation' },
      operation: {
        command: request.command,
        workingDirectory: request.workingDirectory,
        background: false,
        existingTerminal: false,
      },
    }).choices;
  return choices.map(choice => ({
    decision: z.enum(ShellPermissionDecision).parse(choice.id),
    label: choice.label,
    description: choice.description,
  }));
}
