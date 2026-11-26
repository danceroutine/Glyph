import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseSkillManifest } from './SkillManifest.ts';

export const skillPackageDraftSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .max(64),
    source: z.string().min(1).max(2000),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1000),
            content: z.string().max(1400000),
            encoding: z.enum(['utf8', 'base64']),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();
export type SkillPackageDraftInput = z.input<typeof skillPackageDraftSchema>;

/** Complete immutable candidate package. Its revision binds previews and approvals to every reviewed byte. */
export class SkillPackageDraft {
  readonly name: string;
  readonly source: string;
  readonly revision: string;
  private readonly contents = new Map<string, Uint8Array>();
  constructor(input: unknown) {
    const validated = skillPackageDraftSchema.safeParse(input);
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
    for (const file of parsed.files) {
      if (file.path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0:]/u.test(file.path))
        throw new Error('Package files must have relative paths inside the skill.');
      const key = file.path.toLowerCase();
      if (names.has(key)) throw new Error('Package file paths collide.');
      names.add(key);
      const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
      if (file.encoding === 'base64' && bytes.toString('base64') !== file.content)
        throw new Error('Invalid base64 package resource.');
      total += bytes.length;
      if (bytes.length > 1024 * 1024 || total > 8 * 1024 * 1024)
        throw new Error('Skill package exceeds its byte budget.');
      this.contents.set(file.path, bytes);
    }
    const entry = this.contents.get('SKILL.md');
    if (!entry) throw new Error('Skill package is missing SKILL.md.');
    parseSkillManifest(new TextDecoder('utf8', { fatal: true }).decode(entry), this.name);
    this.revision = createHash('sha256')
      .update(
        JSON.stringify(
          [...this.contents]
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]),
        ),
      )
      .digest('hex');
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
        content: Buffer.from(bytes).toString('base64'),
        encoding: 'base64',
      })),
    };
  }
}
