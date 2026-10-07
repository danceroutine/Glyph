import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LogLevel } from './LogLevel.ts';
import type { Logger } from './Logger.ts';

export class FileLogger implements Logger {
  constructor(
    readonly destination: string,
    private readonly namespace?: string,
  ) {}

  forNamespace(namespace: string): Logger {
    return new FileLogger(this.destination, this.namespace ? `${this.namespace}.${namespace}` : namespace);
  }

  trace(message: string, data?: unknown): Promise<void> {
    return this.write(LogLevel.TRACE, message, data);
  }
  debug(message: string, data?: unknown): Promise<void> {
    return this.write(LogLevel.DEBUG, message, data);
  }
  info(message: string, data?: unknown): Promise<void> {
    return this.write(LogLevel.INFO, message, data);
  }
  warn(message: string, data?: unknown): Promise<void> {
    return this.write(LogLevel.WARNING, message, data);
  }
  error(message: string, data?: unknown): Promise<void> {
    return this.write(LogLevel.ERROR, message, data);
  }

  private async write(level: LogLevel, message: string, data?: unknown): Promise<void> {
    await mkdir(dirname(this.destination), { recursive: true, mode: 0o700 });
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: this.namespace ? `${this.namespace}.${message}` : message,
      ...(data === undefined ? {} : { data }),
    };
    const file = await open(
      this.destination,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const identity = await file.stat();
      if (!identity.isFile() || identity.nlink !== 1) {
        throw new Error('Trace destination must be one uniquely linked regular file.');
      }
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
    } finally {
      await file.close();
    }
  }
}
