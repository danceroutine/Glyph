import type { AgentModeID } from '#src/chat/AgentMode.js';
/** Host-owned provenance supplied to tools independently of any model provider protocol. */
export interface ToolExecutionContext {
  /** Host-generated logical turn identity shared by every tool round in one response. */
  readonly turnId?: string;
  /** Keep the contributing workspace roots current when delivering this tool result to the model. */
  readonly retainResultAccess?: (check: () => void) => void;
  readonly executionId?: string;
  readonly mode?: AgentModeID;
  /** Only the approved mode-switch tool invokes this host-owned transition. */
  readonly onModeChanged?: (mode: AgentModeID) => void;
  readonly chat?: {
    readonly id: string;
    readonly accountProvider: string;
    readonly accountId: string;
  };
}
