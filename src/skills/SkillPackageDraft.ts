import { packageRevision, fileRevision } from './skillPackageRevision.ts';
import { z } from 'zod';
import { parseSkillManifest } from './SkillManifest.ts';

const fileSchema = z
  .object({
    path: z.string().min(1).max(1000),
    content: z.string().max(1400000),
    encoding: z.enum(['utf8', 'base64']),
  })
  .strict();
export const skillPackageDraftSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .max(64),
    source: z.string().min(1).max(2000),
    files: z.array(fileSchema).min(1).max(256),
  })
  .strict();
const importedDraft = skillPackageDraftSchema.extend({
  files: z
    .array(fileSchema.extend({ mode: z.number().int().min(0).max(0o777).optional() }))
    .min(1)
    .max(256),
});
export type SkillPackageDraftInput = z.input<typeof importedDraft>;

/** Complete immutable candidate package. Its revision binds previews and approvals to every reviewed byte. */
export class SkillPackageDraft {
  readonly name: string;
  readonly source: string;
  readonly revision: string;
  private readonly contents = new Map<string, Uint8Array>();
  private readonly modes = new Map<string, number>();
  constructor(input: unknown) {
    const validated = importedDraft.safeParse(input);
    if (!validated.success)
      throw new Error(
        validated.error.issues[0]!.path[0] === 'name'
          ? 'Skill names must use 1–64 lowercase letters, numbers, and single hyphens.'
          : 'Provide a complete package with SKILL.md and correctly encoded files within the package limits.',
      );
    const parsed = validated.data;
    this.name = parsed.name;
    this.source = parsed.source;
    let total = 0;
    const names = new Set<string>();
    const directories = new Map<string, string>();
    for (const file of parsed.files) {
      if (file.path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0:]/u.test(file.path))
        throw new Error('Package files must have relative paths inside the skill.');
      const parts = file.path.split('/');
      if (parts.length > 33) throw new Error('Skill package nesting exceeds 32 levels.');
      const key = file.path.normalize('NFC').toLowerCase();
      for (let i = 1; i < parts.length; i++) {
        const directory = parts.slice(0, i).join('/');
        const folded = directory.normalize('NFC').toLowerCase();
        if (names.has(folded) || (directories.has(folded) && directories.get(folded) !== directory))
          throw new Error('Package file paths collide.');
        directories.set(folded, directory);
      }
      if (names.has(key) || directories.has(key)) throw new Error('Package file paths collide.');
      names.add(key);
      const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
      if (file.encoding === 'base64' && bytes.toString('base64') !== file.content)
        throw new Error('Invalid base64 package resource.');
      total += bytes.length;
      if (bytes.length > 1024 * 1024 || total > 8 * 1024 * 1024)
        throw new Error('Skill package exceeds its byte budget.');
      this.contents.set(file.path, bytes);
      if (file.mode !== undefined) this.modes.set(file.path, file.mode);
    }
    const entry = this.contents.get('SKILL.md');
    if (!entry) throw new Error('Skill package is missing SKILL.md.');
    if (entry.length > 256 * 1024) throw new Error('SKILL.md exceeds 256 KiB.');
    if (entry.includes(0)) throw new Error('SKILL.md must be UTF-8 text.');
    const manifest = parseSkillManifest(new TextDecoder('utf8', { fatal: true }).decode(entry), this.name);
    if (Buffer.byteLength(manifest.body) > 64 * 1024) throw new Error('Skill instructions exceed 64 KiB.');
    this.revision = packageRevision(this.packageFiles());
  }
  packageFiles(existing: ReadonlyMap<string, { mode: number }> = new Map()) {
    return new Map(
      [...this.contents].map(([path, bytes]) => {
        const previous = existing.get(path)?.mode;
        const imported = this.modes.get(path);
        // An update may authorize executable bits. Preserve existing restrictions on read/write access.
        const mode =
          previous === undefined
            ? (imported ?? 0o644)
            : imported === undefined
              ? previous
              : (imported & previous & 0o666) | (imported & 0o111 & (previous | ((previous & 0o444) >> 2)));
        return [path, { bytes: Uint8Array.from(bytes), revision: fileRevision(bytes), mode }] as const;
      }),
    );
  }
  files(): ReadonlyMap<string, Uint8Array> {
    return new Map([...this.contents].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
  }
  toJSON(): SkillPackageDraftInput {
    return {
      name: this.name,
      source: this.source,
      files: [...this.contents].map(([path, bytes]) => ({
        path,
        ...(this.modes.has(path) ? { mode: this.modes.get(path)! } : {}),
        content: Buffer.from(bytes).toString('base64'),
        encoding: 'base64',
      })),
    };
  }
}
