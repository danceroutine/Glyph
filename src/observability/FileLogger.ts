import { constants } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LogLevel } from './LogLevel.ts';
import type { Logger } from './Logger.ts';

export class FileLogger implements Logger {
  // Namespace and workspace loggers share this process-wide queue. Descriptor
  // identity also joins alternate spellings and directory aliases of one file.
  private static readonly writers = new Map<string, Promise<void>>();

  constructor(
    readonly destination: string,
    private readonly namespace?: string,
  ) {}

  forNamespace(namespace: string): Logger {
    return new FileLogger(
      this.destination,
      this.namespace !== undefined && this.namespace !== '' ? `${this.namespace}.${namespace}` : namespace,
    );
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
      message: this.namespace !== undefined && this.namespace !== '' ? `${this.namespace}.${message}` : message,
      ...(data === undefined ? {} : { data }),
    };
    const record = `${JSON.stringify(entry)}\n`;
    const file = await open(
      this.destination,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    let key: string;
    try {
      key = await this.validateDestination(file);
    } catch (error) {
      await file.close();
      throw error;
    }
    return this.appendRecord(key, file, record);
  }

  private appendRecord(key: string, file: FileHandle, record: string): Promise<void> {
    const previous = FileLogger.writers.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      try {
        // Link count may change while this descriptor waits for another writer.
        await this.validateDestination(file);
        await file.chmod(0o600);
        // writeFile can yield between chunks. Retain ownership of the complete
        // JSONL record until its write and descriptor cleanup have settled.
        await file.writeFile(record, 'utf8');
      } finally {
        await file.close();
      }
    });
    const settled = result.then(
      () => {},
      () => {},
    );
    FileLogger.writers.set(key, settled);
    return result.finally(() => {
      // A failure releases the next writer; an older completion must not erase
      // the tail of another record already waiting for the same destination.
      if (FileLogger.writers.get(key) === settled) FileLogger.writers.delete(key);
    });
  }

  private async validateDestination(file: FileHandle): Promise<string> {
    const identity = await file.stat({ bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n) {
      throw new Error('Trace destination must be one uniquely linked regular file.');
    }
    return `${identity.dev}:${identity.ino}`;
  }
}
