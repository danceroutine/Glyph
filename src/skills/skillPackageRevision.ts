import { createHash } from 'node:crypto';

export interface SkillFileIdentity {
  readonly revision: string;
  readonly mode: number;
}

/** The approval, installation and activation identify the same paths, bytes and access modes. */
export function packageRevision(files: ReadonlyMap<string, SkillFileIdentity>): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...files.keys()].toSorted().map(path => {
          const file = files.get(path)!;
          return [path, file.revision, file.mode & 0o777];
        }),
      ),
    )
    .digest('hex');
}

export function fileRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
