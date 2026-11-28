import { parseDocument } from 'yaml';
import { z } from 'zod';

const schema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  description: z.string().trim().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.string().optional(),
});

/** Standard package metadata. Tool declarations are retained for execution-policy checks; parsing grants no authority. */
export interface SkillManifest {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly allowedTools: readonly string[];
  readonly body: string;
}

/** Parse the Agent Skills YAML frontmatter without following references or executing package content. */
export function parseSkillManifest(text: string, directoryName: string): SkillManifest {
  const normalized = text.replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  if (!match) throw new Error('SKILL.md needs complete YAML frontmatter.');
  if (Buffer.byteLength(match[1]!) > 16 * 1024) throw new Error('Skill metadata exceeds 16 KiB.');
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) throw new Error('Invalid skill YAML metadata.');
  const parsed = schema.parse(document.toJS({ maxAliasCount: 0 }));
  if (parsed.name !== directoryName) throw new Error('Skill name must match its package directory.');
  return {
    name: parsed.name,
    description: parsed.description,
    metadata: parsed.metadata ?? {},
    allowedTools: parsed['allowed-tools']?.trim().split(/\s+/u).filter(Boolean) ?? [],
    ...(parsed.license ? { license: parsed.license } : {}),
    ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
    body: normalized.slice(match[0].length),
  };
}
