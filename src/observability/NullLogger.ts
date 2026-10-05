import type { Logger } from './Logger.ts';

export class NullLogger implements Logger {
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
