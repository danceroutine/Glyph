import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from '../observability/Logger.ts';
import { NullLogger } from '../observability/NullLogger.ts';
import type { WorkspaceTextSnapshot } from '../workspace/WorkspaceTextSnapshot.ts';
import type { WorkspaceTextStore } from '../workspace/WorkspaceTextStore.ts';
import { EditApplicabilityState } from './EditApplicabilityState.ts';
import { EditDecisionState } from './EditDecisionState.ts';
import { EditError } from './EditError.ts';
import { EditFailureReason } from './EditFailureReason.ts';
import type { EditingConfiguration } from './EditingConfiguration.ts';
import { EditOperation } from './EditOperation.ts';
import type { EditProposal } from './EditProposal.ts';
import { EditReviewItemKind } from './EditReviewItemKind.ts';
import type { FileEditPlan } from './FileEditPlan.ts';
import type { TextDiffer } from './TextDiffer.ts';

const positionSchema = z.object({
  line: z.number().int().nonnegative().describe('Zero-based line number.'),
  character: z.number().int().nonnegative().describe('Zero-based UTF-16 code-unit offset within the line.'),
}).strict();

const textEditSchema = z.object({
  range: z.object({ start: positionSchema, end: positionSchema }).strict(),
  expected_text: z.string().describe('Text that must exactly occupy the range in Base.'),
  replacement_text: z.string().describe('Exact replacement text; an empty string deletes the range.'),
}).strict();

const structuredFileSchema = z.object({
  operation: z.enum(EditOperation).describe('CREATE, UPDATE, RENAME, or DELETE.'),
  path: z.string().min(1).describe('Project-relative source path.'),
  new_path: z.string().min(1).nullable().describe('Project-relative target for RENAME; otherwise null.'),
  base_revision: z.string().min(1).nullable().describe('Revision from read_project_file for existing files; null for CREATE.'),
  content: z.string().nullable().describe('Complete content for CREATE or full replacement; otherwise null when edits are supplied.'),
  bom: z.boolean().nullable().describe('Desired UTF-8 BOM state, or null to preserve/use the default.'),
  edits: z.array(textEditSchema).describe('Exact non-overlapping UTF-16 range edits.'),
}).strict();

const structuredEditProposalSchema = z.object({ files: z.array(structuredFileSchema) }).strict();

type StructuredProposal = z.infer<typeof structuredEditProposalSchema>;
type StructuredFile = z.infer<typeof structuredFileSchema>;

interface PatchFile {
  operation: EditOperation;
  path: string;
  targetPath?: string;
  revision?: string;
  bom?: boolean;
  eol?: '\n' | '\r\n' | '\r';
  hunks: PatchHunk[];
  content?: string;
  noFinalNewline?: boolean;
}

interface PatchHunk { lines: { prefix: ' ' | '+' | '-'; text: string }[]; }

export class EditProposalService {
  static readonly structuredSchema = structuredEditProposalSchema;

  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly differ: TextDiffer,
    private readonly configuration: EditingConfiguration,
    private readonly logger: Logger = new NullLogger(),
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async proposeStructured(raw: unknown): Promise<EditProposal> {
    const rawBytes = Buffer.byteLength(JSON.stringify(raw));
    this.enforceRawLimit(rawBytes);
    const parsed = structuredEditProposalSchema.safeParse(raw);
    if (!parsed.success) {
      throw new EditError(EditFailureReason.MALFORMED, `Malformed structured edit proposal:\n${z.prettifyError(parsed.error)}`);
    }
    return this.compile(parsed.data, 'structured');
  }

  async proposePatch(patch: string): Promise<EditProposal> {
    this.enforceRawLimit(Buffer.byteLength(patch));
    const files = parsePatch(patch);
    const structured: StructuredProposal = { files: [] };
    for (const file of files) {
      if (file.operation === EditOperation.CREATE) {
        const content = (file.content ?? '').replace(/\n/g, file.eol ?? this.configuration.newFileEol);
        structured.files.push({
          operation: file.operation,
          path: file.path,
          new_path: null,
          base_revision: null,
          content: applyFinalNewline(content, file.noFinalNewline),
          bom: file.bom ?? this.configuration.newFileBom,
          edits: [],
        });
        continue;
      }
      const base = await this.workspace.read(file.path);
      if (!file.revision) throw new EditError(EditFailureReason.MALFORMED, 'Update, rename, and delete patches require a Revision directive.', { path: file.path });
      if (file.revision !== base.revision) {
        throw new EditError(EditFailureReason.STALE, 'Patch base revision does not match the current file.', {
          path: file.path,
          currentRevision: base.revision,
          retry: 'Read the file again and regenerate the patch.',
        });
      }
      if (file.operation === EditOperation.DELETE) {
        structured.files.push({ operation: file.operation, path: file.path, new_path: null, base_revision: file.revision, content: null, bom: null, edits: [] });
        continue;
      }
      let proposed = base.text;
      for (const hunk of file.hunks) {
        const oldLogical = hunk.lines.filter(line => line.prefix !== '+').map(line => line.text);
        const newLogical = hunk.lines.filter(line => line.prefix !== '-').map(line => line.text);
        const eol = file.eol ?? dominantEol(base.text);
        const oldText = oldLogical.join(eol);
        const newText = newLogical.join(eol);
        const candidates = indexesOf(proposed, oldText);
        if (candidates.length === 0) {
          throw new EditError(EditFailureReason.INCONSISTENT, 'Patch context does not exactly match the base file.', { path: file.path });
        }
        if (candidates.length > 1) {
          throw new EditError(EditFailureReason.AMBIGUOUS, 'Patch context matches more than one location.', {
            path: file.path,
            candidates: candidates.map(offset => lineAt(proposed, offset)),
            retry: 'Include more unique context or use structured coordinates.',
          });
        }
        const offset = candidates[0]!;
        proposed = proposed.slice(0, offset) + newText + proposed.slice(offset + oldText.length);
      }
      proposed = applyFinalNewline(proposed, file.noFinalNewline);
      structured.files.push({
        operation: file.operation,
        path: file.path,
        new_path: file.targetPath ?? null,
        base_revision: file.revision,
        content: proposed,
        bom: file.bom ?? base.bom,
        edits: [],
      });
    }
    return this.compile(structured, 'patch');
  }

  private async compile(input: StructuredProposal, source: EditProposal['source']): Promise<EditProposal> {
    if (input.files.length === 0) throw new EditError(EditFailureReason.EMPTY, 'An edit proposal must contain at least one file.');
    if (input.files.length > this.configuration.maxFiles) {
      throw new EditError(EditFailureReason.LIMIT_EXCEEDED, `Proposal exceeds the ${this.configuration.maxFiles}-file limit.`);
    }
    const normalized = input.files.map(file => ({
      ...file,
      path: this.workspace.normalizePath(file.path),
      new_path: file.new_path === null ? null : this.workspace.normalizePath(file.new_path),
    }));
    validatePathGraph(normalized, this.workspace.caseSensitive);

    const plans: FileEditPlan[] = [];
    const identities = new Set<string>();
    let changedBytes = 0;
    let totalHunks = 0;
    for (const file of normalized) {
      const plan = await this.compileFile(file);
      if (plan.base && identities.has(plan.base.identity)) {
        throw new EditError(EditFailureReason.AMBIGUOUS, 'Multiple proposal paths resolve to the same filesystem identity.', { path: plan.sourcePath });
      }
      if (plan.base) identities.add(plan.base.identity);
      const changedItems = plan.items.filter(item => item.kind !== EditReviewItemKind.RENAME);
      changedBytes += changedItems.reduce((sum, item) => sum + Buffer.byteLength(item.removedText) + Buffer.byteLength(item.insertedText), 0);
      totalHunks += plan.items.length;
      if (plan.proposed.byteLength > this.configuration.maxResultingBytesPerFile) {
        throw new EditError(EditFailureReason.LIMIT_EXCEEDED, 'Resulting file exceeds the configured byte limit.', { path: plan.targetPath });
      }
      if (plan.items.length > this.configuration.maxHunksPerFile) {
        throw new EditError(EditFailureReason.LIMIT_EXCEEDED, 'File exceeds the configured hunk limit.', { path: plan.sourcePath });
      }
      plans.push(plan);
    }
    if (changedBytes > this.configuration.maxChangedBytes || totalHunks > this.configuration.maxTotalHunks) {
      throw new EditError(EditFailureReason.LIMIT_EXCEEDED, 'Proposal exceeds the configured changed-byte or hunk limit.');
    }
    const proposal: EditProposal = {
      schemaVersion: 1,
      id: this.createId(),
      source,
      createdAt: this.now().toISOString(),
      files: plans,
    };
    await this.logger.info('edit.proposal.validated', { proposalId: proposal.id, source, files: plans.length, hunks: totalHunks, changedBytes });
    return proposal;
  }

  private async compileFile(file: StructuredFile): Promise<FileEditPlan> {
    const existing = await this.workspace.readOptional(file.path);
    if (file.operation === EditOperation.CREATE) {
      if (existing) throw new EditError(EditFailureReason.INCONSISTENT, 'Create target already exists.', { path: file.path });
      if (file.base_revision !== null || file.new_path !== null || file.content === null || file.edits.length > 0) {
        throw new EditError(EditFailureReason.MALFORMED, 'CREATE requires content and null revision/new_path with no edits.', { path: file.path });
      }
      const proposed = snapshot(file.path, file.content, file.bom ?? this.configuration.newFileBom, 0o644);
      const fileId = this.createId();
      const item = structuralItem(fileId, EditReviewItemKind.CREATE, '', proposed.text);
      return plan(fileId, file, null, proposed, [item]);
    }
    if (!existing) throw new EditError(EditFailureReason.INCONSISTENT, 'Proposal source does not exist.', { path: file.path });
    if (file.base_revision === null) throw new EditError(EditFailureReason.MALFORMED, 'Existing-file operations require base_revision.', { path: file.path });
    if (file.base_revision !== existing.revision) {
      throw new EditError(EditFailureReason.STALE, 'Base revision does not match the current file.', { path: file.path, currentRevision: existing.revision });
    }
    if (file.operation === EditOperation.DELETE) {
      if (file.new_path !== null || file.content !== null || file.edits.length > 0) {
        throw new EditError(EditFailureReason.MALFORMED, 'DELETE accepts only path and base_revision.', { path: file.path });
      }
      const fileId = this.createId();
      return plan(fileId, file, existing, snapshot(file.path, existing.text, existing.bom, existing.mode), [
        structuralItem(fileId, EditReviewItemKind.DELETE, existing.text, ''),
      ]);
    }
    if (file.operation === EditOperation.UPDATE && file.new_path !== null) {
      throw new EditError(EditFailureReason.MALFORMED, 'UPDATE does not accept new_path.', { path: file.path });
    }
    if (file.content !== null && file.edits.length > 0) {
      throw new EditError(EditFailureReason.INCONSISTENT, 'A file cannot declare both full content and ranged edits.', { path: file.path });
    }
    if (file.operation === EditOperation.RENAME && (!file.new_path || file.new_path === file.path)) {
      throw new EditError(EditFailureReason.EMPTY, 'RENAME requires a distinct new_path.', { path: file.path });
    }
    const proposedText = file.content ?? applyTextEdits(existing.text, file.edits, file.path);
    const target = file.new_path ?? file.path;
    if (file.operation === EditOperation.RENAME && await this.workspace.readOptional(target)) {
      throw new EditError(EditFailureReason.INCONSISTENT, 'Rename target already exists.', { path: target });
    }
    const proposed = snapshot(target, proposedText, file.bom ?? existing.bom, existing.mode);
    const fileId = this.createId();
    const diffStarted = performance.now();
    const items = this.differ.createReviewItems(fileId, existing.text, proposedText);
    if (performance.now() - diffStarted > this.configuration.diffBudgetMs) {
      throw new EditError(EditFailureReason.LIMIT_EXCEEDED, 'Diff computation exceeded the configured time budget.', { path: file.path });
    }
    if (file.operation === EditOperation.RENAME) items.unshift(structuralItem(fileId, EditReviewItemKind.RENAME, file.path, target));
    if (items.length === 0 && proposed.bom === existing.bom) {
      throw new EditError(EditFailureReason.EMPTY, 'Proposed replacement is identical to the base.', { path: file.path });
    }
    if (items.length === 0) items.push(structuralItem(fileId, EditReviewItemKind.TEXT, existing.text, proposedText));
    return plan(fileId, file, existing, proposed, items);
  }

  private enforceRawLimit(bytes: number): void {
    if (bytes > this.configuration.maxRawProposalBytes) {
      throw new EditError(EditFailureReason.LIMIT_EXCEEDED, `Proposal exceeds the ${this.configuration.maxRawProposalBytes}-byte raw limit.`);
    }
  }
}

function plan(
  id: string,
  file: StructuredFile,
  base: WorkspaceTextSnapshot | null,
  proposed: WorkspaceTextSnapshot,
  items: FileEditPlan['items'],
): FileEditPlan {
  return {
    id,
    operation: file.operation,
    sourcePath: file.path,
    targetPath: file.new_path ?? file.path,
    base,
    proposed,
    items,
    current: base,
    applyingItemId: null,
    createdDirectories: [],
    applicability: EditApplicabilityState.READY,
    currentPath: file.path,
    currentRevision: base?.revision ?? null,
  };
}

function snapshot(path: string, text: string, bom: boolean, mode: number): WorkspaceTextSnapshot {
  const content = Buffer.from(text, 'utf8');
  const bytes = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content]) : content;
  return { path, text, bom, mode, byteLength: bytes.length, revision: createHash('sha256').update(bytes).digest('hex'), identity: `proposed:${path}` };
}

function structuralItem(fileId: string, kind: EditReviewItemKind, removedText: string, insertedText: string): FileEditPlan['items'][number] {
  return {
    id: createHash('sha256').update(`structure-v1\0${fileId}\0${kind}\0${removedText}\0${insertedText}`).digest('hex'),
    fileId,
    kind,
    sourceStart: 0,
    sourceEnd: removedText.length,
    removedText,
    insertedText,
    decision: EditDecisionState.PENDING,
  };
}

function applyTextEdits(text: string, edits: StructuredFile['edits'], path: string): string {
  const resolved = edits.map(edit => {
    const start = offsetAt(text, edit.range.start.line, edit.range.start.character, path);
    const end = offsetAt(text, edit.range.end.line, edit.range.end.character, path);
    if (end < start) throw new EditError(EditFailureReason.INCONSISTENT, 'Edit range ends before it starts.', { path });
    if (text.slice(start, end) !== edit.expected_text) {
      throw new EditError(EditFailureReason.INCONSISTENT, 'Edit expected_text does not match Base exactly.', { path });
    }
    return { start, end, replacement: edit.replacement_text };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < resolved.length; index++) {
    const previous = resolved[index - 1]!;
    const current = resolved[index]!;
    if (current.start < previous.end || (current.start === previous.start && current.end === current.start && previous.end === previous.start)) {
      throw new EditError(EditFailureReason.AMBIGUOUS, 'Edits overlap or contain multiple insertions at the same offset.', { path });
    }
  }
  let result = text;
  for (const edit of [...resolved].reverse()) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  return result;
}

function offsetAt(text: string, line: number, character: number, path: string): number {
  const ranges = lineRanges(text);
  const range = ranges[line];
  if (!range || character > range.end - range.start) {
    throw new EditError(EditFailureReason.INCONSISTENT, 'Edit position is outside Base.', { path });
  }
  const offset = range.start + character;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
    throw new EditError(EditFailureReason.INCONSISTENT, 'Edit boundary splits a UTF-16 surrogate pair.', { path });
  }
  return offset;
}

function lineRanges(text: string): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\n' && text[index] !== '\r') continue;
    result.push({ start, end: index });
    if (text[index] === '\r' && text[index + 1] === '\n') index++;
    start = index + 1;
  }
  result.push({ start, end: text.length });
  return result;
}

function validatePathGraph(files: StructuredFile[], caseSensitive: boolean): void {
  const sources = new Set<string>();
  const touched = new Set<string>();
  for (const file of files) {
    const sourceNfc = file.path.normalize('NFC');
    const target = file.new_path ?? file.path;
    const targetNfc = target.normalize('NFC');
    const foldedSource = sourceNfc.toLocaleLowerCase('en-US');
    const foldedTarget = targetNfc.toLocaleLowerCase('en-US');
    const sourceKey = caseSensitive ? sourceNfc : foldedSource;
    const targetKey = caseSensitive ? targetNfc : foldedTarget;
    if (sources.has(sourceKey) || touched.has(sourceKey)) {
      throw new EditError(EditFailureReason.AMBIGUOUS, 'Proposal contains duplicate or aliased file paths.', { path: file.path });
    }
    if (file.operation === EditOperation.RENAME && !caseSensitive && foldedSource === foldedTarget && file.path !== target) {
      throw new EditError(EditFailureReason.UNSUPPORTED, 'Case-only renames are not portable across workspace filesystems.', { path: file.path });
    }
    sources.add(sourceKey);
    touched.add(sourceKey);
    if (targetKey !== sourceKey) {
      if (touched.has(targetKey)) throw new EditError(EditFailureReason.AMBIGUOUS, 'Proposal contains duplicate or aliased file paths.', { path: target });
      touched.add(targetKey);
    }
  }
  for (const file of files) {
    const target = (file.new_path ?? '').normalize('NFC');
    const targetKey = caseSensitive ? target : target.toLocaleLowerCase('en-US');
    if (file.operation === EditOperation.RENAME && sources.has(targetKey)) {
      throw new EditError(EditFailureReason.AMBIGUOUS, 'Rename chains and swaps are not supported in one proposal.', { path: file.path });
    }
  }
}

function parsePatch(patch: string): PatchFile[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') {
    throw new EditError(EditFailureReason.MALFORMED, 'Patch must start with *** Begin Patch and end with *** End Patch.');
  }
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  let hunk: PatchHunk | undefined;
  const finish = (): void => { if (current) files.push(current); current = undefined; hunk = undefined; };
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      finish();
      current = { operation: header[1] === 'Add' ? EditOperation.CREATE : header[1] === 'Delete' ? EditOperation.DELETE : EditOperation.UPDATE, path: header[2]!, hunks: [] };
      continue;
    }
    if (!current) {
      if (line === '') continue;
      throw new EditError(EditFailureReason.MALFORMED, `Unrecognized patch directive: ${line}`);
    }
    if (line.startsWith('*** Revision: ')) { current.revision = line.slice(14); continue; }
    if (line.startsWith('*** Move to: ')) { current.operation = EditOperation.RENAME; current.targetPath = line.slice(13); continue; }
    if (line.startsWith('*** BOM: ')) {
      const value = line.slice(9);
      if (!['true', 'false'].includes(value)) throw new EditError(EditFailureReason.MALFORMED, 'BOM directive must be true or false.');
      current.bom = value === 'true'; continue;
    }
    if (line.startsWith('*** EOL: ')) {
      const value = line.slice(9);
      if (value === 'LF') current.eol = '\n';
      else if (value === 'CRLF') current.eol = '\r\n';
      else if (value === 'CR') current.eol = '\r';
      else throw new EditError(EditFailureReason.MALFORMED, 'EOL directive must be LF, CRLF, or CR.');
      continue;
    }
    if (line === '\\ No newline at end of file') { current.noFinalNewline = true; continue; }
    if (line === '@@') { hunk = { lines: [] }; current.hunks.push(hunk); continue; }
    const prefix = line[0];
    if (prefix === '+' || prefix === '-' || prefix === ' ') {
      if (current.operation === EditOperation.CREATE && !hunk) current.content = `${current.content ?? ''}${line.slice(1)}\n`;
      else {
        if (!hunk) throw new EditError(EditFailureReason.MALFORMED, 'Patch change lines require an @@ hunk marker.', { path: current.path });
        hunk.lines.push({ prefix, text: line.slice(1) });
      }
      continue;
    }
    if (line === '') continue;
    throw new EditError(EditFailureReason.MALFORMED, `Unrecognized patch directive: ${line}`, { path: current.path });
  }
  finish();
  if (files.length === 0) throw new EditError(EditFailureReason.EMPTY, 'Patch contains no files.');
  for (const file of files) {
    if (file.operation === EditOperation.CREATE && file.content === undefined) file.content = '';
    if ((file.operation === EditOperation.UPDATE || file.operation === EditOperation.RENAME) && file.hunks.length === 0) {
      throw new EditError(EditFailureReason.EMPTY, 'Update patch contains no hunks.', { path: file.path });
    }
  }
  return files;
}

function indexesOf(text: string, search: string): number[] {
  if (!search) return [];
  const result: number[] = [];
  for (let offset = text.indexOf(search); offset >= 0; offset = text.indexOf(search, offset + 1)) {
    const before = offset === 0 ? '' : text[offset - 1];
    const end = offset + search.length;
    const after = end === text.length ? '' : text[end];
    const startsOnLine = offset === 0 || before === '\n' || before === '\r';
    const endsOnLine = end === text.length || after === '\n' || after === '\r';
    if (startsOnLine && endsOnLine) result.push(offset);
  }
  return result;
}

function lineAt(text: string, offset: number): number { return text.slice(0, offset).split(/\r\n|\r|\n/).length; }

function dominantEol(text: string): '\n' | '\r\n' | '\r' {
  const matches = text.match(/\r\n|\r|\n/g) ?? [];
  const counts = new Map<string, number>();
  for (const value of matches) counts.set(value, (counts.get(value) ?? 0) + 1);
  return ([...counts].sort((left, right) => right[1] - left[1])[0]?.[0] as '\n' | '\r\n' | '\r' | undefined) ?? '\n';
}

function applyFinalNewline(text: string, absent: boolean | undefined): string {
  if (absent) return text.replace(/(?:\r\n|\r|\n)$/, '');
  return text;
}
