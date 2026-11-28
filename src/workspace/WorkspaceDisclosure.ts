import type { PinnedSourceAuthority } from './PinnedSourceAuthority.ts';

/** Host-only evidence retained from a workspace read until its result reaches the model.
 * Root and reservation guards survive waits. Derived captures can additionally repeat
 * their live access checks after the provider prepares a request or retries delivery. */
export class WorkspaceDisclosure {
  readonly additionalPaths = new Set<string>();
  private readonly checks = new Set<() => void>();
  private readonly validators = new Set<(signal: AbortSignal) => Promise<() => void>>();

  retain = (check: () => void): void => {
    this.checks.add(check);
  };

  assertCurrent = (): void => {
    for (const check of this.checks) check();
  };

  revalidate(validate: (signal: AbortSignal) => Promise<() => void>): void {
    this.validators.add(validate);
  }

  /** Bind a file's observed identity to the physical route that supplied the snapshot. */
  async retainFile(authority: PinnedSourceAuthority, path: string, identity: string): Promise<void> {
    const [pin] = await authority.capture([path]);
    if (pin?.identity !== identity) throw new Error('The source changed while reading it.');
    this.revalidate(signal => authority.authorize([pin], signal));
  }

  get hasValidators(): boolean {
    return this.validators.size > 0;
  }

  get hasSources(): boolean {
    return this.checks.size > 0 || this.validators.size > 0;
  }

  async authorize(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    this.assertCurrent();
    const current = await Promise.all([...this.validators].map(validate => validate(signal)));
    const check = () => {
      signal.throwIfAborted();
      this.assertCurrent();
      for (const run of current) run();
    };
    check();
    return check;
  }
}
