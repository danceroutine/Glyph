import type { Logger } from './Logger.ts';

export class NullLogger implements Logger {
  forNamespace(): Logger {
    return this;
  }
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
