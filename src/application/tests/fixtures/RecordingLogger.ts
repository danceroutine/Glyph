import type { Logger } from '../../../observability/Logger.ts';

export class RecordingLogger implements Logger {
  constructor(
    readonly entries: { level: string; message: string; data?: unknown }[] = [],
    private readonly namespace?: string,
  ) {}

  forNamespace(namespace: string): Logger {
    return new RecordingLogger(this.entries, this.namespace ? `${this.namespace}.${namespace}` : namespace);
  }

  trace(message: string, data?: unknown): void {
    this.record('trace', message, data);
  }
  debug(message: string, data?: unknown): void {
    this.record('debug', message, data);
  }
  info(message: string, data?: unknown): void {
    this.record('info', message, data);
  }
  warn(message: string, data?: unknown): void {
    this.record('warn', message, data);
  }
  error(message: string, data?: unknown): void {
    this.record('error', message, data);
  }

  private record(level: string, message: string, data?: unknown): void {
    this.entries.push({
      level,
      message: this.namespace ? `${this.namespace}.${message}` : message,
      ...(data === undefined ? {} : { data }),
    });
  }
}
