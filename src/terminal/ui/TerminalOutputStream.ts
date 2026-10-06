export interface TerminalOutputStream extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
}
