import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';

type RawInput = NodeJS.ReadableStream & {
  readonly isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
  resume(): void;
  pause(): void;
};

export class TerminalInput {
  private readonly reader: Interface;
  private closed = false;
  private raw = false;

  constructor(
    private readonly source: RawInput = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ) {
    this.reader = createInterface({ input: source, output });
    this.reader.on('close', () => { this.closed = true; });
  }

  get isTTY(): boolean { return this.source.isTTY === true && typeof this.source.setRawMode === 'function'; }

  on(event: 'SIGINT' | 'close', listener: () => void): void { this.reader.on(event, listener); }
  off(event: 'SIGINT', listener: () => void): void { this.reader.off(event, listener); }

  async question(prompt: string, signal: AbortSignal): Promise<string> {
    if (this.closed) throw new Error('Session closed.');
    if (this.raw) throw new Error('Cannot prompt while terminal raw-key mode is active.');
    return this.reader.question(prompt, { signal });
  }

  enterRawMode(): void {
    if (!this.isTTY || this.raw) return;
    this.raw = true;
    this.reader.pause();
    this.source.setRawMode?.(true);
    this.source.resume();
  }

  leaveRawMode(): void {
    if (!this.raw) return;
    this.source.setRawMode?.(false);
    this.source.pause();
    this.reader.resume();
    this.raw = false;
  }

  nextKey(signal: AbortSignal): Promise<string> {
    if (!this.raw) throw new Error('Raw-key mode is not active.');
    return new Promise((resolve, reject) => {
      const onData = (data: Buffer | string): void => { cleanup(); resolve(String(data)); };
      const onAbort = (): void => { cleanup(); reject(signal.reason ?? new Error('Input cancelled.')); };
      const cleanup = (): void => {
        this.source.off('data', onData);
        signal.removeEventListener('abort', onAbort);
      };
      this.source.once('data', onData);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  close(): void {
    this.leaveRawMode();
    if (!this.closed) this.reader.close();
  }
}
