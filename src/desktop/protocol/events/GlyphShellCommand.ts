/** Display projection of a command; live authority comes only from the current host. */
export interface GlyphShellCommand {
  readonly wakePattern?: string;
  readonly command: string;
  readonly output: string;
  readonly workingDirectory?: string;
  readonly sessionId?: string;
  readonly exitCode?: number;
  readonly error?: string;
  readonly background: boolean;
  readonly live: boolean;
  readonly running: boolean;
}
