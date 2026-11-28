import fs, { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Selects one physical user profile for the host lifetime. A later retarget of the configured alias affects the next
 * host. The retained directory descriptor identifies the selected object even when its name is removed and reused.
 * Consumers use `path` for reservations and watch roots, verify at access boundaries, and call `ensureDirectory`
 * before creating profile contents. Disposing the host releases its descriptor. Files inside the profile remain live.
 */
export class StartupUserProfile {
  readonly path: string;
  private anchor: string;
  private revision = 0;
  private descriptor: number | undefined;

  constructor(configuredPath: string) {
    const selected = selectDirectory(resolve(configuredPath));
    this.path = selected.path;
    this.anchor = selected.anchor;
    this.descriptor = this.open(this.anchor);
  }

  /** Verify the enrolled directory and return its current authority revision, pinning any newly created components. */
  verify(): number {
    this.check(false);
    return this.revision;
  }

  /** Create missing profile components beneath their verified parent using owner-only permissions. */
  ensureDirectory(): void {
    this.check(true);
  }

  /** Verify both sides of an asynchronous access before releasing its result. Writers also verify at publication. */
  async access<T>(operation: () => Promise<T>): Promise<T> {
    const revision = this.verify();
    const result = await operation();
    if (this.verify() !== revision) throw changed();
    return result;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  dispose(): void {
    if (this.descriptor !== undefined) fs.closeSync(this.descriptor);
    this.descriptor = undefined;
  }

  private check(create: boolean): void {
    try {
      this.inspectDirectory(create);
    } catch (error) {
      // Invalidate outstanding operations in every consumer, including after the original directory returns.
      this.revision++;
      throw error;
    }
  }

  private inspectDirectory(create: boolean): void {
    if (this.descriptor === undefined) throw new Error('The user profile authority is closed.');
    const inspect = () => {
      const observed = fs.lstatSync(this.anchor, { bigint: true, throwIfNoEntry: false });
      const pinned = fs.fstatSync(this.descriptor!, { bigint: true });
      if (
        observed?.dev !== pinned.dev ||
        observed.ino !== pinned.ino ||
        fs.realpathSync.native(this.anchor) !== this.anchor
      )
        throw changed();
    };
    inspect();
    for (const child of missingComponents(this.anchor, this.path)) {
      const observed = fs.lstatSync(child, { throwIfNoEntry: false });
      if (!observed) {
        if (!create) return;
        fs.mkdirSync(child, { mode: 0o700 });
      } else if (!observed.isDirectory()) throw changed();
      const next = this.open(child);
      try {
        inspect();
      } catch (error) {
        fs.closeSync(next);
        throw error;
      }
      fs.closeSync(this.descriptor);
      this.descriptor = next;
      this.anchor = child;
      inspect();
    }
  }

  private open(directory: string): number {
    return fs.openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  }
}

function changed(): Error {
  return new Error(
    'The startup user profile directory was removed or replaced. Restore it or restart Glyph to select a profile.',
  );
}

function missingComponents(anchor: string, selected: string): string[] {
  const parts: string[] = [];
  for (let path = selected; path !== anchor; path = dirname(path)) parts.push(path);
  return parts.toReversed();
}

/** Resolve startup symlinks, including a selected link whose target directory has yet to be created. */
function selectDirectory(selected: string, links = 0): { anchor: string; path: string } {
  let existing = selected;
  let entry = fs.lstatSync(existing, { throwIfNoEntry: false });
  while (!entry) {
    existing = dirname(existing);
    entry = fs.lstatSync(existing, { throwIfNoEntry: false });
  }
  const suffix = missingComponents(existing, selected).map(component => basename(component));
  if (entry.isSymbolicLink()) {
    if (links >= 40) throw new Error('Too many user profile directory links.');
    return selectDirectory(resolve(dirname(existing), fs.readlinkSync(existing), ...suffix), links + 1);
  }
  if (!entry.isDirectory()) throw new Error('The configured user profile must select a directory.');
  const anchor = fs.realpathSync.native(existing);
  return { anchor, path: join(anchor, ...suffix) };
}
