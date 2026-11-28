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
    return this.retainFiles(authority, [{ path, identity }]);
  }

  /** Search may return several match lines from one descriptor. Enroll the selected files in
   * a single authority request, then repeat that batch at first delivery and SDK retries. */
  async retainFiles(
    authority: PinnedSourceAuthority,
    files: readonly { path: string; identity: string }[],
    signal?: AbortSignal,
  ): Promise<void> {
    const identities = new Map<string, string>();
    for (const { path, identity } of files) {
      if (identities.has(path) && identities.get(path) !== identity)
        throw new Error('The source changed while reading it.');
      identities.set(path, identity);
    }
    if (identities.size === 0) return;
    const paths = [...identities.keys()];
    const pins = await authority.capture(paths, signal);
    if (pins.length !== paths.length || pins.some((pin, index) => pin.identity !== identities.get(paths[index]!)))
      throw new Error('The source changed while reading it.');
    this.revalidate(cancellation => authority.authorize(pins, cancellation));
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
