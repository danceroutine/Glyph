/** An unavailable or stale conversation checkpoint. */
export class ChatHistoryError extends Error {
  override readonly name = 'ChatHistoryError';
}
