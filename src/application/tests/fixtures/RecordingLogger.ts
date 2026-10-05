import type { Logger } from '../../../observability/Logger.ts';

export class RecordingLogger implements Logger {
  readonly entries: { level: string; message: string; data?: unknown }[] = [];
  trace(message: string, data?: unknown): void { this.entries.push({ level: 'trace', message, ...(data === undefined ? {} : { data }) }); }
  debug(message: string, data?: unknown): void { this.entries.push({ level: 'debug', message, ...(data === undefined ? {} : { data }) }); }
  info(message: string, data?: unknown): void { this.entries.push({ level: 'info', message, ...(data === undefined ? {} : { data }) }); }
  warn(message: string, data?: unknown): void { this.entries.push({ level: 'warn', message, ...(data === undefined ? {} : { data }) }); }
  error(message: string, data?: unknown): void { this.entries.push({ level: 'error', message, ...(data === undefined ? {} : { data }) }); }
}
