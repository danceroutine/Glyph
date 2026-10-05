export interface Logger {
  readonly destination?: string;
  trace(message: string, data?: unknown): void | Promise<void>;
  debug(message: string, data?: unknown): void | Promise<void>;
  info(message: string, data?: unknown): void | Promise<void>;
  warn(message: string, data?: unknown): void | Promise<void>;
  error(message: string, data?: unknown): void | Promise<void>;
}
