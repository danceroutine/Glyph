import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from '../../observability/Logger.ts';
import { NullLogger } from '../../observability/NullLogger.ts';
import type { WorkspaceTextSnapshot } from '../../workspace/WorkspaceTextSnapshot.ts';
import type { WorkspaceTextStore } from '../../workspace/WorkspaceTextStore.ts';
import type { EditingConfiguration } from '../configuration/EditingConfiguration.ts';
import { TextDocument } from '../documents/TextDocument.ts';
import type { TextDiffer } from '../documents/TextDiffer.ts';
import { EditError } from '../errors/EditError.ts';
import { EditFailureReason } from '../errors/EditFailureReason.ts';
import { EditApplicabilityState } from '../reviews/EditApplicabilityState.ts';
import { EditDecisionState } from '../reviews/EditDecisionState.ts';
import { EditReviewItemKind } from '../reviews/EditReviewItemKind.ts';
import { EditOperation } from './EditOperation.ts';
import type { EditProposal } from './EditProposal.ts';
import type { FileEditPlan } from './FileEditPlan.ts';

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
  byte_order_mark: z.boolean().nullable().describe('Whether to include a UTF-8 byte order mark, or null to preserve/use the default.'),
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
  byteOrderMark?: boolean;
  lineEnding?: '\n' | '\r\n' | '\r';
  hunks: PatchHunk[];
  content?: string;
  noFinalNewline?: boolean;
}

interface PatchHunk { lines: { prefix: ' ' | '+' | '-'; text: string }[]; }

export class EditProposalService {
  static readonly structuredSchema = structuredEditProposalSchema;
  private readonly logger: Logger;

  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly differ: TextDiffer,
    private readonly configuration: EditingConfiguration,
    logger: Logger = new NullLogger(),
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.logger = logger.forNamespace('editing.proposal');
  }

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
        const content = (file.content ?? '').replace(/\n/g, file.lineEnding ?? this.configuration.newFileLineEnding);
        structured.files.push({
          operation: file.operation,
          path: file.path,
          new_path: null,
          base_revision: null,
          content: applyFinalNewline(content, file.noFinalNewline),
          byte_order_mark: file.byteOrderMark ?? this.configuration.newFileByteOrderMark,
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
        structured.files.push({ operation: file.operation, path: file.path, new_path: null, base_revision: file.revision, content: null, byte_order_mark: null, edits: [] });
        continue;
      }
      let proposed = base.text;
      for (const hunk of file.hunks) {
        const oldLogical = hunk.lines.filter(line => line.prefix !== '+').map(line => line.text);
        const newLogical = hunk.lines.filter(line => line.prefix !== '-').map(line => line.text);
        const lineEnding = file.lineEnding ?? dominantLineEnding(base.text);
        const oldText = oldLogical.join(lineEnding);
        const newText = newLogical.join(lineEnding);
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
        byte_order_mark: file.byteOrderMark ?? base.byteOrderMark,
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
    await this.logger.info('validated', { proposalId: proposal.id, source, files: plans.length, hunks: totalHunks, changedBytes });
    return proposal;
  }

  private async compileFile(file: StructuredFile): Promise<FileEditPlan> {
    const existing = await this.workspace.readOptional(file.path);
    switch (file.operation) {
      case EditOperation.CREATE:
        return this.compileCreate(file, existing);
      case EditOperation.DELETE:
        return this.compileDelete(file, this.requireExistingBase(file, existing));
      case EditOperation.UPDATE:
      case EditOperation.RENAME:
        return this.compileTextChange(file, this.requireExistingBase(file, existing));
    }
  }

  private compileCreate(file: StructuredFile, existing: WorkspaceTextSnapshot | undefined): FileEditPlan {
    if (existing) throw new EditError(EditFailureReason.INCONSISTENT, 'Create target already exists.', { path: file.path });
    if (file.base_revision !== null || file.new_path !== null || file.content === null || file.edits.length > 0) {
      throw new EditError(EditFailureReason.MALFORMED, 'CREATE requires content and null revision/new_path with no edits.', { path: file.path });
    }
    const proposed = toWorkspaceTextSnapshot(
      file.path,
      file.content,
      file.byte_order_mark ?? this.configuration.newFileByteOrderMark,
      0o644,
    );
    const fileId = this.createId();
    const item = toStructuralItem(fileId, EditReviewItemKind.CREATE, '', proposed.text);
    return toFileEditPlan(fileId, file, null, proposed, [item]);
  }

  private requireExistingBase(
    file: StructuredFile,
    existing: WorkspaceTextSnapshot | undefined,
  ): WorkspaceTextSnapshot {
    if (!existing) throw new EditError(EditFailureReason.INCONSISTENT, 'Proposal source does not exist.', { path: file.path });
    if (file.base_revision === null) throw new EditError(EditFailureReason.MALFORMED, 'Existing-file operations require base_revision.', { path: file.path });
    if (file.base_revision !== existing.revision) {
      throw new EditError(EditFailureReason.STALE, 'Base revision does not match the current file.', { path: file.path, currentRevision: existing.revision });
    }
    return existing;
  }

  private compileDelete(file: StructuredFile, existing: WorkspaceTextSnapshot): FileEditPlan {
    if (file.new_path !== null || file.content !== null || file.edits.length > 0) {
      throw new EditError(EditFailureReason.MALFORMED, 'DELETE accepts only path and base_revision.', { path: file.path });
    }
    const fileId = this.createId();
    return toFileEditPlan(
      fileId,
      file,
      existing,
      toWorkspaceTextSnapshot(file.path, existing.text, existing.byteOrderMark, existing.mode),
      [toStructuralItem(fileId, EditReviewItemKind.DELETE, existing.text, '')],
    );
  }

  private async compileTextChange(file: StructuredFile, existing: WorkspaceTextSnapshot): Promise<FileEditPlan> {
    if (file.operation === EditOperation.UPDATE && file.new_path !== null) {
      throw new EditError(EditFailureReason.MALFORMED, 'UPDATE does not accept new_path.', { path: file.path });
    }
    if (file.operation === EditOperation.RENAME && (!file.new_path || file.new_path === file.path)) {
      throw new EditError(EditFailureReason.EMPTY, 'RENAME requires a distinct new_path.', { path: file.path });
    }
    if (file.content !== null && file.edits.length > 0) {
      throw new EditError(EditFailureReason.INCONSISTENT, 'A file cannot declare both full content and ranged edits.', { path: file.path });
    }
    const proposedText = file.content ?? new TextDocument(file.path, existing.text).apply(file.edits);
    const target = file.new_path ?? file.path;
    if (file.operation === EditOperation.RENAME && await this.workspace.readOptional(target)) {
      throw new EditError(EditFailureReason.INCONSISTENT, 'Rename target already exists.', { path: target });
    }
    const proposed = toWorkspaceTextSnapshot(target, proposedText, file.byte_order_mark ?? existing.byteOrderMark, existing.mode);
    const fileId = this.createId();
    const diffStarted = performance.now();
    const items = this.differ.createReviewItems(fileId, existing.text, proposedText);
    if (performance.now() - diffStarted > this.configuration.diffBudgetMs) {
      throw new EditError(EditFailureReason.LIMIT_EXCEEDED, 'Diff computation exceeded the configured time budget.', { path: file.path });
    }
    if (file.operation === EditOperation.RENAME) items.unshift(toStructuralItem(fileId, EditReviewItemKind.RENAME, file.path, target));
    if (items.length === 0 && proposed.byteOrderMark === existing.byteOrderMark) {
      throw new EditError(EditFailureReason.EMPTY, 'Proposed replacement is identical to the base.', { path: file.path });
    }
    if (items.length === 0) items.push(toStructuralItem(fileId, EditReviewItemKind.TEXT, existing.text, proposedText));
    return toFileEditPlan(fileId, file, existing, proposed, items);
  }

  private enforceRawLimit(bytes: number): void {
    if (bytes > this.configuration.maxRawProposalBytes) {
      throw new EditError(EditFailureReason.LIMIT_EXCEEDED, `Proposal exceeds the ${this.configuration.maxRawProposalBytes}-byte raw limit.`);
    }
  }
}

function toFileEditPlan(
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

function toWorkspaceTextSnapshot(path: string, text: string, byteOrderMark: boolean, mode: number): WorkspaceTextSnapshot {
  const content = Buffer.from(text, 'utf8');
  const bytes = byteOrderMark ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content]) : content;
  return { path, text, byteOrderMark, mode, byteLength: bytes.length, revision: createHash('sha256').update(bytes).digest('hex'), identity: `proposed:${path}` };
}

function toStructuralItem(fileId: string, kind: EditReviewItemKind, removedText: string, insertedText: string): FileEditPlan['items'][number] {
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
  const lines = patch.replace(/\r\n|\r/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
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
    if (line.startsWith('*** Byte Order Mark: ')) {
      const value = line.slice(21);
      if (!['true', 'false'].includes(value)) throw new EditError(EditFailureReason.MALFORMED, 'Byte Order Mark directive must be true or false.');
      current.byteOrderMark = value === 'true'; continue;
    }
    if (line.startsWith('*** Line Ending: ')) {
      const value = line.slice(17);
      if (value === 'LF') current.lineEnding = '\n';
      else if (value === 'CRLF') current.lineEnding = '\r\n';
      else if (value === 'CR') current.lineEnding = '\r';
      else throw new EditError(EditFailureReason.MALFORMED, 'Line Ending directive must be LF, CRLF, or CR.');
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

function dominantLineEnding(text: string): '\n' | '\r\n' | '\r' {
  const matches = text.match(/\r\n|\r|\n/g) ?? [];
  const counts = new Map<string, number>();
  for (const value of matches) counts.set(value, (counts.get(value) ?? 0) + 1);
  return ([...counts].sort((left, right) => right[1] - left[1])[0]?.[0] as '\n' | '\r\n' | '\r' | undefined) ?? '\n';
}

function applyFinalNewline(text: string, absent: boolean | undefined): string {
  if (absent) return text.replace(/(?:\r\n|\r|\n)$/, '');
  return text;
}
