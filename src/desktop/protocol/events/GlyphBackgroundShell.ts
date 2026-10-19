/** Live, read-only projection of an agent-owned background process. */
export interface GlyphBackgroundShell {
  readonly id: string;
  readonly chatId: string;
  readonly command: string;
  readonly workingDirectory: string;
  readonly output: string;
  readonly running: boolean;
  readonly error?: string;
  readonly exitCode?: number;
  readonly wakePattern?: string;
}
