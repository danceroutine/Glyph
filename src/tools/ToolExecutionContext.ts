import type { AgentModeID } from "#src/chat/AgentMode.js";
/** Host-owned provenance supplied to tools independently of any model provider protocol. */
export interface ToolExecutionContext {
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
