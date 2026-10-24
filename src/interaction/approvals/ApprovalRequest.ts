import type { AgentModeID } from '#src/chat/AgentMode.js';
import type { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';
import type { ApprovalCapability } from './ApprovalCapability.ts';

export interface WorkspaceScope {
  readonly workspaceId: string;
  readonly mutationScope: string;
}
export type ShellChoiceEffect =
  | { readonly disposition: 'deny'; readonly grant: null | 'safe_inspection' }
  | {
      readonly disposition: 'allow';
      readonly sandbox: ShellSandboxProfile.READ_ONLY | ShellSandboxProfile.WORKSPACE_WRITE;
      readonly grant: null | 'safe_inspection' | 'exact_command';
    }
  | {
      readonly disposition: 'allow';
      readonly sandbox: ShellSandboxProfile.FULL_ACCESS;
      readonly grant: null | 'all_shell_commands';
    };
export type WebChoiceEffect =
  | { readonly disposition: 'deny'; readonly grant: null }
  | { readonly disposition: 'allow'; readonly grant: null | 'all_internal_web' };
export interface OneShotChoiceEffect {
  readonly disposition: 'allow' | 'deny';
  readonly grant: null;
}
export interface ApprovalDefinitions {
  [ApprovalCapability.SHELL]: {
    readonly operation: {
      readonly command: string;
      readonly workingDirectory: string;
      readonly background: boolean;
      readonly existingTerminal: boolean;
    };
    readonly effect: ShellChoiceEffect;
  };
  [ApprovalCapability.INTERNAL_WEB]: {
    readonly operation: { readonly url: string; readonly method: 'GET'; readonly resolvedAddresses: readonly string[] };
    readonly effect: WebChoiceEffect;
  };
  [ApprovalCapability.GOAL]: {
    readonly operation: { readonly objective: string };
    readonly effect: OneShotChoiceEffect;
  };
  [ApprovalCapability.MODE_SWITCH]: {
    readonly operation: { readonly source: AgentModeID; readonly target: AgentModeID; readonly explanation: string };
    readonly effect: OneShotChoiceEffect;
  };
}
export interface ApprovalChoice<C extends ApprovalCapability> {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly effect: ApprovalDefinitions[C]['effect'];
}
export interface ApprovalRequest<C extends ApprovalCapability> {
  readonly capability: C;
  readonly workspace: WorkspaceScope;
  readonly operation: ApprovalDefinitions[C]['operation'];
  readonly title: string;
  readonly detail: string;
  readonly choices: readonly ApprovalChoice<C>[];
  readonly timeout: C extends ApprovalCapability.MODE_SWITCH
    ? { readonly afterMilliseconds: number; readonly choiceId: string } | null
    : null;
}
export type ApprovalRequestInput<C extends ApprovalCapability> = Pick<ApprovalRequest<C>, 'workspace' | 'operation'>;
export type AuthorizedEffect<C extends ApprovalCapability> = ApprovalDefinitions[C]['effect'] & {
  readonly disposition: 'allow';
  readonly grant: null;
};
