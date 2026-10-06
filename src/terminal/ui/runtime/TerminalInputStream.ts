export interface TerminalInputStream extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(enabled: boolean): void;
  resume(): this;
  pause(): this;
}
