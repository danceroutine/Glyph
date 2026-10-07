/** Host-owned provenance supplied to tools independently of any model provider protocol. */
export interface ToolExecutionContext {
  readonly chat?: {
    readonly id: string;
    readonly accountProvider: string;
    readonly accountId: string;
  };
}
