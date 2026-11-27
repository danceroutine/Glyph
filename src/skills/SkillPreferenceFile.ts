import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { optionalStat } from './SkillPackageStorage.ts';
import { inspectFileMetadata, type FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import { readHostFile } from './readHostFile.ts';
import { fileRevision } from './skillPackageRevision.ts';

type Snapshot = NonNullable<Awaited<ReturnType<SkillPreferenceFile['read']>>>;

/**
 * Owns the single private skill preferences file. Each read verifies the opened object's ownership, link count
 * and native metadata, and each replacement binds to the previously read object and revision. Only the preferences
 * service receives this authority. Callers hold its profile lock and recheck the private staging directory before publication.
 */
export class SkillPreferenceFile {
  readonly path: string;
  constructor(
    readonly directory: string,
    private readonly metadata: FilesystemMetadata,
  ) {
    this.path = join(directory, 'skill-state.json');
  }

  async read() {
    if (!(await optionalStat(this.path))) return undefined;
    const { bytes, ...details } = await readHostFile(this.path, undefined, handle => this.inspect(handle));
    return { ...details, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), revision: fileRevision(bytes) };
  }

  async inspect(handle: FileHandle): Promise<void> {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0))
    )
      throw new Error('Skill preferences must belong to the current user and must not be writable by other users.');
    await this.metadata.inspect(handle, 'replaceable');
  }

  async replace(previous: Snapshot, text: string, stage: string, checkDirectories: () => Promise<void>): Promise<void> {
    const temporary = join(stage, '.' + randomUUID() + '.glyph.tmp');
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, previous.mode);
    try {
      try {
        await handle.writeFile(text);
        await handle.chmod(previous.mode);
        const stat = await handle.stat();
        if (stat.uid !== previous.uid || stat.gid !== previous.gid || (stat.mode & 0o7777) !== previous.mode)
          throw new Error('Replacement cannot preserve the existing preference ownership and permissions.');
        await this.inspect(handle);
      } finally {
        await handle.close();
      }
      await checkDirectories();
      await inspectFileMetadata(this.metadata, temporary, 'replaceable');
      const current = await this.read();
      if (
        current?.revision !== previous.revision ||
        current.dev !== previous.dev ||
        current.ino !== previous.ino ||
        current.uid !== previous.uid ||
        current.gid !== previous.gid ||
        current.mode !== previous.mode
      )
        throw new Error('Skill preferences changed before publication.');
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
