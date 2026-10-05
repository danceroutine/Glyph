/**
 * Host-neutral structured logging port. Namespaces let domains emit short,
 * local event names while adapters preserve a globally searchable hierarchy.
 */
export interface Logger {
  readonly destination?: string;
  forNamespace(namespace: string): Logger;
  trace(message: string, data?: unknown): void | Promise<void>;
  debug(message: string, data?: unknown): void | Promise<void>;
  info(message: string, data?: unknown): void | Promise<void>;
  warn(message: string, data?: unknown): void | Promise<void>;
  error(message: string, data?: unknown): void | Promise<void>;
}
