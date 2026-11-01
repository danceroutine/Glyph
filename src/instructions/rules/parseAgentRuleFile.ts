import { AgentInstructionActivationMode } from '#src/instructions/AgentInstructionSource.js';
import type { AgentRuleFile } from './AgentRuleFile.ts';
import { globExpression } from './matchesAgentRulePath.ts';

const MAX_DESCRIPTION_LENGTH = 2_000;
const ACTIVATION_MODES: Readonly<Record<string, AgentInstructionActivationMode>> = {
  always: AgentInstructionActivationMode.ALWAYS,
  file_pattern: AgentInstructionActivationMode.FILE_PATTERN,
  model: AgentInstructionActivationMode.MODEL,
  manual: AgentInstructionActivationMode.MANUAL,
};

/** Parse the intentionally small YAML-compatible frontmatter supported by Glyph rules. */
export function parseAgentRuleFile(text: string): AgentRuleFile {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n'))
    return { globs: [], enabled: true, references: [], body: text };
  const normalized = text.replaceAll('\r\n', '\n');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('Rule frontmatter is missing its closing --- delimiter.');
  const metadata = parseMetadata(normalized.slice(4, end));
  const description = optionalString(metadata.description, 'description');
  if (description && description.length > MAX_DESCRIPTION_LENGTH)
    throw new Error(`Rule description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`);
  const globs = stringList(metadata.globs, 'globs');
  for (const glob of globs) globExpression(glob);
  const references = stringList(metadata.references, 'references');
  const activationValue = optionalString(metadata.activation, 'activation');
  const activation = activationValue ? activationMode(activationValue) : undefined;
  const alwaysApply = optionalBoolean(metadata.alwaysApply, 'alwaysApply');
  const enabled = optionalBoolean(metadata.enabled, 'enabled') ?? true;
  const name = optionalString(metadata.name, 'name');
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(activation ? { activation } : {}),
    globs,
    ...(alwaysApply === undefined ? {} : { alwaysApply }),
    enabled,
    references,
    body: normalized.slice(end + 5),
  };
}

type MetadataValue = string | boolean | readonly string[];

function parseMetadata(frontmatter: string): Readonly<Record<string, MetadataValue>> {
  const result: Record<string, MetadataValue> = {};
  let activeList: string[] | undefined;
  for (const rawLine of frontmatter.split('\n')) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue;
    const item = /^\s+-\s+(.+)$/u.exec(rawLine);
    if (item) {
      if (!activeList) throw new Error('Rule frontmatter list item has no property.');
      const value = item[1]!;
      activeList.push(scalarString(value));
      continue;
    }
    const property = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))$/u.exec(rawLine);
    if (!property) throw new Error(`Invalid rule frontmatter line: ${rawLine}`);
    const key = property[1]!;
    const rawValue = property[2]!;
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate rule frontmatter property: ${key}`);
    activeList = undefined;
    const value = rawValue.trim();
    if (value === '') {
      const values: string[] = [];
      result[key] = values;
      activeList = values;
    } else if (value.startsWith('[')) result[key] = inlineList(value);
    else if (value === 'true' || value === 'false') result[key] = value === 'true';
    else result[key] = scalarString(value);
  }
  return result;
}

function inlineList(value: string): readonly string[] {
  if (!value.endsWith(']')) throw new Error('Rule frontmatter inline list is missing ].');
  const body = value.slice(1, -1).trim();
  return body === '' ? [] : body.split(',').map(part => scalarString(part.trim()));
}

function scalarString(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    return value.slice(1, -1);
  if (value.includes(': #')) return value.slice(0, value.indexOf(' #')).trimEnd();
  return value;
}

function optionalString(value: MetadataValue | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Rule frontmatter property ${key} must be a string.`);
  return value.trim() || undefined;
}

function optionalBoolean(value: MetadataValue | undefined, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Rule frontmatter property ${key} must be true or false.`);
  return value;
}

function stringList(value: MetadataValue | undefined, key: string): readonly string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (!isStringArray(value)) throw new Error(`Rule frontmatter property ${key} must be a string or list.`);
  return value;
}

function activationMode(value: string): AgentInstructionActivationMode {
  const normalized = value.replaceAll('-', '_');
  const mode = ACTIVATION_MODES[normalized];
  if (mode === undefined) throw new Error(`Unknown rule activation mode: ${value}`);
  return mode;
}

function isStringArray(value: MetadataValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
