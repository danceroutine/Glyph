import { isAbsolute } from 'node:path';

/** A host-selected executable and immutable argument vector, independent of shell syntax. */
export class ShellProgram {
  readonly arguments: readonly string[];

  constructor(
    readonly executable: string,
    arguments_: readonly string[],
    readonly description: string,
    private readonly validateAuthority?: () => Promise<void | (() => void)>,
  ) {
    if (!isAbsolute(executable) || executable.includes('\0') || arguments_.some(argument => argument.includes('\0')))
      throw new Error('A program requires an absolute executable and arguments without NUL characters.');
    this.arguments = Object.freeze([...arguments_]);
    Object.freeze(this);
  }

  /**
   * Obtain fresh authority before exposing the approval text or launching the
   * process. Invoke the returned guard at synchronous handoff so revocation
   * during async preparation takes effect before the command reaches its caller.
   */
  async assertAuthority(): Promise<void | (() => void)> {
    return this.validateAuthority?.();
  }

  /** Approval text describes the exact argument boundaries; it is never parsed as a shell command. */
  get display(): string {
    return `${this.description}\n${[this.executable, ...this.arguments].map(value => JSON.stringify(value)).join(' ')}`;
  }
}
