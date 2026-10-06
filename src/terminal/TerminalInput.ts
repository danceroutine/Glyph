import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';

type RawInput = NodeJS.ReadableStream & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(enabled: boolean): void;
  resume(): void;
  pause(): void;
};

export class TerminalInput {
  private readonly reader: Interface;
  private closed = false;
  private raw = false;
  private previousRaw = false;
  private readonly keys: string[] = [];
  private keyWaiter: ((key: string) => void) | undefined;
  private readonly handleKeypress = (value: string | undefined, key: { sequence?: string }): void => {
    if (!this.raw) return;
    const sequence = key.sequence ?? value ?? '';
    const waiter = this.keyWaiter;
    if (waiter) {
      this.keyWaiter = undefined;
      waiter(sequence);
    } else this.keys.push(sequence);
  };

  constructor(
    private readonly source: RawInput = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ) {
    this.reader = createInterface({ input: source, output });
    this.reader.on('close', () => {
      this.closed = true;
    });
    emitKeypressEvents(source);
    source.on('keypress', this.handleKeypress);
  }

  get isTTY(): boolean {
    return this.source.isTTY === true && typeof this.source.setRawMode === 'function';
  }

  on(event: 'SIGINT' | 'close', listener: () => void): void {
    this.reader.on(event, listener);
  }
  off(event: 'SIGINT', listener: () => void): void {
    this.reader.off(event, listener);
  }

  async question(prompt: string, signal: AbortSignal): Promise<string> {
    if (this.closed) throw new Error('Session closed.');
    if (this.raw) throw new Error('Cannot prompt while terminal raw-key mode is active.');
    return this.reader.question(prompt, { signal });
  }

  enterRawMode(): void {
    if (!this.isTTY || this.raw) return;
    this.raw = true;
    this.previousRaw = this.source.isRaw === true;
    this.reader.pause();
    this.source.setRawMode?.(true);
    this.source.resume();
  }

  leaveRawMode(): void {
    if (!this.raw) return;
    // A composer can finish on Enter after it has already requested the next
    // key. Settle that orphaned read before another raw-mode owner acquires it.
    this.keyWaiter?.('');
    this.source.setRawMode?.(this.previousRaw);
    this.source.pause();
    this.reader.resume();
    this.raw = false;
    this.previousRaw = false;
    this.keys.length = 0;
  }

  nextKey(signal: AbortSignal): Promise<string> {
    if (!this.raw) throw new Error('Raw-key mode is not active.');
    const queued = this.keys.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.keyWaiter) throw new Error('Only one raw-key consumer may read terminal input at a time.');
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        reject(signal.reason ?? new Error('Input cancelled.'));
      };
      const cleanup = (): void => {
        this.keyWaiter = undefined;
        signal.removeEventListener('abort', onAbort);
      };
      this.keyWaiter = key => {
        cleanup();
        resolve(key);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Re-emits raw Ctrl+C through the same channel used by readline prompts. */
  requestInterrupt(): void {
    this.reader.emit('SIGINT');
  }

  close(): void {
    this.leaveRawMode();
    this.source.off('keypress', this.handleKeypress);
    if (!this.closed) this.reader.close();
  }
}
