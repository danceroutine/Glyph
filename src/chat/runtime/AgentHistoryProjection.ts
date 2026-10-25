/**
 * Runtime-owned transformation from live conversation content to durable history.
 * Adapters locate these fields in their protocol records and preserve all other
 * content, ordering, call identities, and opaque provider state without interpreting it.
 */
export interface AgentHistoryProjection {
  /** Project a plain user-message body. Undefined removes the complete message. */
  userMessage(content: string): string | undefined;
  /** Project a serialized tool result, preserving the surrounding result and its call identity. */
  toolOutput(output: string): string;
}
