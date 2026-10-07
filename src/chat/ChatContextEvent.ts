/** Durable host event that becomes model context independently of user turns. */
export interface ChatContextEvent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
}
