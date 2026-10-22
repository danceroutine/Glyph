import { UNDO_REDO_SOURCE as EXPLORER_UNDO_REDO_SOURCE } from '#vs/workbench/contrib/files/browser/explorerService.js';
import { VSBuffer } from '#vs/base/common/buffer.js';
import { GlyphFileMutationKind, type GlyphFileMutation } from '#glyph/protocol/editor/GlyphFileMutation.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#glyph/protocol/connection/GlyphContextAttachment.js';
import type { GlyphTextRange } from '#glyph/protocol/connection/GlyphTextRange.js';
import { IInstantiationService } from '#vs/platform/instantiation/common/instantiation.js';
import { Progress } from '#vs/platform/progress/common/progress.js';
import { BulkTextEdits } from '#vs/workbench/contrib/bulkEdit/browser/bulkTextEdits.js';
import { URI } from '#vs/base/common/uri.js';
import { getGlyphWorkspaceRootId } from '#glyph/protocol/connection/getGlyphWorkspaceRootId.js';
import { generateUuid } from '#vs/base/common/uuid.js';
import { Disposable } from '#vs/base/common/lifecycle.js';
import { CancellationTokenSource } from '#vs/base/common/cancellation.js';
import { IModelService } from '#vs/editor/common/services/model.js';
import {
  ITextFileService,
  TextFileOperationError,
  TextFileOperationResult,
} from '#vs/workbench/services/textfile/common/textfiles.js';
import { IWorkspaceTrustManagementService } from '#vs/platform/workspace/common/workspaceTrust.js';
import { IUserDataProfileService } from '#vs/workbench/services/userDataProfile/common/userDataProfile.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '#vs/platform/files/common/files.js';
import { IUriIdentityService } from '#vs/platform/uriIdentity/common/uriIdentity.js';
import { GlyphEditorRequestType, type GlyphEditorRequest } from '#glyph/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#glyph/protocol/editor/GlyphEditorResponse.js';
import { GlyphWorkingCopyPatternKind } from '#glyph/protocol/editor/GlyphWorkingCopySearchOptions.js';
import type { GlyphWorkingCopySearchMatch } from '#glyph/protocol/editor/GlyphWorkingCopySearchMatch.js';
import { ResourceFileEdit, ResourceTextEdit, IBulkEditService } from '#vs/editor/browser/services/bulkEditService.js';
import { EndOfLineSequence, type ITextModel } from '#vs/editor/common/model.js';
import { EditSources } from '#vs/editor/common/textModelEditSource.js';
import { ITextModelService } from '#vs/editor/common/services/resolverService.js';
import { IWorkspaceContextService } from '#vs/platform/workspace/common/workspace.js';
import { UndoRedoGroup } from '#vs/platform/undoRedo/common/undoRedo.js';
import type { GlyphDocumentToken } from '#glyph/protocol/connection/GlyphDocumentToken.js';
import type { GlyphEditorTextSnapshot } from '#glyph/protocol/editor/GlyphEditorTextSnapshot.js';
import type { GlyphMutationReceipt } from '#glyph/protocol/editor/GlyphMutationReceipt.js';
import type { GlyphTextMutation } from '#glyph/protocol/editor/GlyphTextMutation.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';
import { GlyphMutationReceiptState } from '#glyph/protocol/editor/GlyphMutationReceipt.js';

import { GlyphEditorAdapterError } from './GlyphEditorAdapterError.js';

/**
 * Applies host-requested edits through Code OSS's live text models so dirty
 * buffers, undo/redo, and autosave semantics remain native. The adapter also
 * issues ephemeral capabilities that prevent a stale proposal from targeting a
 * different model incarnation with coincidentally identical text.
 */
export class GlyphEditorAdapter extends Disposable {
  /** Weak keys let model disposal retire incarnation ids without manual cleanup. */
  private readonly incarnations = new WeakMap<ITextModel, string>();
  /** Receipts make operation ids idempotent across a lost renderer response. */
  private readonly receipts = new Map<string, GlyphMutationReceipt>();
  private readonly pendingMutations = new Set<CancellationTokenSource>();
  /** Maps protocol grouping ids onto Code OSS's process-local undo groups. */
  private readonly undoGroups = new Map<string, UndoRedoGroup>();
  private readonly removedResources = new Set<string>();
  private workspaceGeneration = generateUuid();
  private workspaceBinding: string;
  private workspaceChanged = false;
  /** Keep unopened models alive while the host holds their incarnation tokens. */
  private readonly references = new Map<string, Awaited<ReturnType<ITextModelService['createModelReference']>>>();

  constructor(
    @ITextModelService private readonly textModelService: ITextModelService,
    @IBulkEditService private readonly bulkEditService: IBulkEditService,
    @IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
    @IModelService private readonly modelService: IModelService,
    @ITextFileService private readonly textFileService: ITextFileService,
    @IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
    @IFileService private readonly fileService: IFileService,
    @IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
    @IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
    @IInstantiationService private readonly instantiationService: IInstantiationService,
  ) {
    super();
    this.workspaceBinding = this.currentWorkspaceBinding();
    this._register(
      this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
        this.workspaceChanged = true;
        this.invalidate();
      }),
    );
    for (const changed of [
      this.workspaceContextService.onDidChangeWorkspaceName,
      this.workspaceContextService.onDidChangeWorkbenchState,
      this.userDataProfileService.onDidChangeCurrentProfile,
    ]) {
      this._register(
        changed(() => {
          if (this.workspaceChanged || this.currentWorkspaceBinding() === this.workspaceBinding) return;
          this.workspaceChanged = true;
          this.invalidate();
        }),
      );
    }
  }

  /** Serializes failures at the process boundary while keeping typed errors inside the adapter. */
  async handle(request: GlyphEditorRequest): Promise<GlyphEditorResponse> {
    const operationId =
      request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION ||
      request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION
        ? request.mutation.operationId
        : request.operationId;
    try {
      // Recovery inspects recorded evidence, not the current workspace. A root
      // change must not hide a write that completed before access was revoked.
      if (request.type === GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT)
        return { operationId, ok: true, receipt: await this.inspectReceipt(operationId) };
      this.assertWorkspaceBinding();
      if (!this.trustService.isWorkspaceTrusted())
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE);
      switch (request.type) {
        case GlyphEditorRequestType.EXISTS:
          return { operationId, ok: true, exists: await this.exists(request.path) };
        case GlyphEditorRequestType.READ_SNAPSHOT:
          return { operationId, ok: true, snapshot: await this.read(request.path, request.maxBytes) };
        case GlyphEditorRequestType.APPLY_FILE_MUTATION:
          return { operationId, ok: true, ...(await this.applyFile(request.mutation)) };
        case GlyphEditorRequestType.APPLY_TEXT_MUTATION:
          return { operationId, ok: true, ...(await this.apply(request.mutation)) };
        case GlyphEditorRequestType.LIST_WORKING_COPIES:
          return { operationId, ok: true, workingCopies: await this.workingCopies() };
        case GlyphEditorRequestType.LIST_WORKING_COPY_PATHS: {
          const models = this.modelService
            .getModels()
            .filter(model => model.uri.scheme === 'file' && this.workspaceContextService.isInsideWorkspace(model.uri));
          if (models.length > 2000)
            throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED, {
              maximumWorkingCopies: 2000,
              workingCopies: models.length,
            });
          return { operationId, ok: true, workingCopyPaths: models.map(model => this.pathFor(model.uri)) };
        }
        case GlyphEditorRequestType.SEARCH_WORKING_COPIES:
          return await this.searchWorkingCopies(request);
      }
    } catch (error) {
      const code = this.errorCode(error);
      return {
        operationId,
        ok: false,
        ...(this.receipts.has(operationId) ? { receipt: this.receipts.get(operationId) } : {}),
        error: {
          code,
          message: error instanceof Error ? error.message : String(error),
          retryable: code === GlyphDesktopErrorCode.STALE_DOCUMENT,
          ...(error instanceof GlyphEditorAdapterError && error.details ? { details: error.details } : {}),
        },
      };
    }
  }

  /** Invalidates every previously issued token after workspace or ownership changes. */
  invalidate(): void {
    for (const mutation of this.pendingMutations) mutation.cancel();
    this.workspaceGeneration = generateUuid();
    for (const reference of this.references.values()) reference.dispose();
    this.references.clear();
  }

  /** Called only after the previous runtime has drained, before attaching its replacement. */
  rebindWorkspace(): void {
    this.invalidate();
    this.workspaceBinding = this.currentWorkspaceBinding();
    this.workspaceChanged = false;
  }

  override dispose(): void {
    this.invalidate();
    super.dispose();
  }

  contextPath(resource: URI): string {
    this.assertWorkspaceBinding();
    if (!['file', 'untitled'].includes(resource.scheme))
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE);
    return resource.scheme === 'untitled' ? resource.path.replace(/^\//u, '') : this.pathFor(resource);
  }

  isCurrentContext(model: ITextModel, attachment: GlyphContextAttachment): boolean {
    return (
      attachment.token?.workspaceGeneration === this.workspaceGeneration &&
      attachment.token.incarnation === this.incarnation(model) &&
      attachment.token.version === model.getVersionId()
    );
  }

  async captureContext(model: ITextModel, range?: GlyphTextRange): Promise<GlyphContextAttachment> {
    this.assertWorkspaceBinding();
    if (!this.trustService.isWorkspaceTrusted())
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE);
    if (!['file', 'untitled'].includes(model.uri.scheme))
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE);
    const path = this.contextPath(model.uri);
    const token = {
      workspaceGeneration: this.workspaceGeneration,
      resource: model.uri.toString(),
      incarnation: this.incarnation(model),
      version: model.getVersionId(),
    };
    if (!range) this.assertReadBudget(model.getValueLength(), 512 * 1024);
    if (range) {
      const { start, end } = range;
      if (
        start.line < 1 ||
        end.line > model.getLineCount() ||
        start.line > end.line ||
        start.column < 1 ||
        end.column < 1 ||
        start.column > model.getLineMaxColumn(start.line) ||
        end.column > model.getLineMaxColumn(end.line) ||
        (start.line === end.line && start.column > end.column)
      )
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
    }
    const text = range
      ? model.getValueInRange({
          startLineNumber: range.start.line,
          startColumn: range.start.column,
          endLineNumber: range.end.line,
          endColumn: range.end.column,
        })
      : model.getValue();
    this.assertReadBudget(new TextEncoder().encode(text).byteLength, 512 * 1024);
    const contentRevision = await sha256(text, false);
    this.assertWorkspaceBinding();
    if (!this.trustService.isWorkspaceTrusted())
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE);
    if (token.workspaceGeneration !== this.workspaceGeneration)
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
    return {
      id: generateUuid(),
      kind: range ? GlyphContextAttachmentKind.SELECTION : GlyphContextAttachmentKind.FILE,
      uri: model.uri.toString(),
      path,
      text,
      contentRevision,
      sourceRevision: `${token.workspaceGeneration}:${token.incarnation}:${token.version}`,
      token,
      ...(range ? { range } : {}),
    };
  }

  /** Reads through a model reference so unopened files and dirty open files share one path. */
  async read(path: string, maxBytes?: number): Promise<GlyphEditorTextSnapshot> {
    const resource = this.resolve(path);
    if (
      this.removedResources.has(resource.toString()) &&
      !this.textFileService.isDirty(resource) &&
      !(await this.fileService.exists(resource))
    )
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.NOT_FOUND);
    if (maxBytes !== undefined) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.INVALID_REQUEST);
      if (!this.modelService.getModel(resource)) {
        const info = await this.fileService.stat(resource);
        if (info.size !== undefined) this.assertReadBudget(info.size, maxBytes);
      }
    }
    const reference = await this.reference(resource);
    return this.snapshot(path, reference.object.textEditorModel, maxBytes);
  }

  /** Structural edits go through native Bulk Edit so Explorer, open editors and Undo stay coordinated. */
  async applyFile(
    mutation: GlyphFileMutation,
  ): Promise<{ snapshot?: GlyphEditorTextSnapshot; receipt: GlyphMutationReceipt }> {
    const targetPath = mutation.kind === GlyphFileMutationKind.RENAME ? mutation.target : mutation.path;
    if (targetPath === undefined || targetPath === '')
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.INVALID_REQUEST);
    const known = this.receipts.get(mutation.operationId);
    if (known) {
      if (known.state !== GlyphMutationReceiptState.APPLIED)
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
      if (mutation.kind === GlyphFileMutationKind.DELETE) {
        if (await this.exists(mutation.path)) throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
        return { receipt: known };
      }
      let snapshot = await this.read(targetPath);
      if (snapshot.contentRevision !== known.afterRevision)
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
      if (mutation.save === true) snapshot = await this.saveMutation(targetPath, snapshot.contentRevision);
      return { snapshot, receipt: known };
    }
    const source = this.resolve(mutation.path);
    const target = this.resolve(targetPath);
    const generation = this.workspaceGeneration;
    const cancellation = new CancellationTokenSource();
    this.pendingMutations.add(cancellation);
    let changed: { dispose(): void } | undefined;
    try {
      const before = mutation.kind === GlyphFileMutationKind.CREATE ? undefined : await this.read(mutation.path);
      /* v8 ignore else -- @preserve */
      if (before && mutation.kind !== GlyphFileMutationKind.CREATE) {
        if (
          !areSameTokens(before.token, mutation.expectedToken) ||
          before.contentRevision !== mutation.expectedContentRevision
        )
          throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
        // Native deletion backs up disk bytes for Undo. Never discard an unsaved buffer.
        if (mutation.kind === GlyphFileMutationKind.DELETE && before.dirty)
          throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT, {
            reason: 'Save or revert unsaved changes before deleting this file.',
          });
        if (!before.dirty) {
          const bytes = (await this.fileService.readFile(source)).value.buffer;
          const digest = Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
            byte => byte.toString(16).padStart(2, '0'),
          ).join('');
          if (digest !== before.contentRevision)
            throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
        }
        const model = this.modelService.getModel(source);
        if (!model || model.getVersionId() !== before.token.version)
          throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
        changed = model.onDidChangeContent(() => {
          cancellation.cancel();
        });
      }
      if (mutation.kind !== GlyphFileMutationKind.DELETE && (await this.exists(targetPath)))
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT, {
          reason: 'The destination already exists.',
        });
      const edit =
        mutation.kind === GlyphFileMutationKind.CREATE
          ? new ResourceFileEdit(undefined, target, {
              overwrite: false,
              contents: Promise.resolve(VSBuffer.fromString((mutation.byteOrderMark ? '\uFEFF' : '') + mutation.text)),
            })
          : new ResourceFileEdit(source, mutation.kind === GlyphFileMutationKind.RENAME ? target : undefined, {
              overwrite: false,
              recursive: false,
              maxSize: 2 * 1024 * 1024 + 3,
            });
      edit.validate = async () => {
        this.assertWorkspaceBinding();
        if (!this.trustService.isWorkspaceTrusted())
          throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE);
        if (generation !== this.workspaceGeneration || cancellation.token.isCancellationRequested)
          throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
        if (before) {
          const current = await this.read(mutation.path);
          if (!areSameTokens(current.token, before.token) || current.contentRevision !== before.contentRevision)
            throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
          if (!current.dirty) {
            const bytes = (await this.fileService.readFile(source)).value.buffer;
            const revision = Array.from(
              new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
              byte => byte.toString(16).padStart(2, '0'),
            ).join('');
            if (revision !== before.contentRevision)
              throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
          }
        }
        if (mutation.kind !== GlyphFileMutationKind.DELETE && (await this.exists(targetPath)))
          throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT, {
            reason: 'The destination already exists.',
          });
        this.assertWorkspaceBinding();
        if (!this.trustService.isWorkspaceTrusted())
          throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE);
        if (
          generation !== this.workspaceGeneration ||
          cancellation.token.isCancellationRequested ||
          (before && this.modelService.getModel(source)?.getVersionId() !== before.token.version)
        )
          throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
      };
      await edit.validate();
      const result = await this.bulkEditService.apply([edit], {
        label: 'Apply Glyph file change',
        code: 'glyph.applyFile',
        undoRedoSource: EXPLORER_UNDO_REDO_SOURCE,
        undoRedoGroupId: this.undoGroup(mutation.undoGroupId).id,
        token: cancellation.token,
        respectAutoSaveConfig: true,
      });
      if (!result.isApplied) throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
      // Retain evidence before any later snapshot request can fail.
      const receipt: GlyphMutationReceipt = {
        operationId: mutation.operationId,
        state: GlyphMutationReceiptState.UNKNOWN,
        beforeRevision: before?.contentRevision ?? '',
        observedAt: new Date().toISOString(),
      };
      this.receipts.set(mutation.operationId, receipt);
      if (mutation.kind !== GlyphFileMutationKind.CREATE) this.removedResources.add(source.toString());
      if (mutation.kind !== GlyphFileMutationKind.DELETE) this.removedResources.delete(target.toString());
      this.references.get(source.toString())?.dispose();
      this.references.delete(source.toString());
      if (mutation.kind === GlyphFileMutationKind.DELETE) {
        if (await this.fileService.exists(source)) {
          this.receipts.set(mutation.operationId, { ...receipt, state: GlyphMutationReceiptState.UNKNOWN });
          throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
        }
        const complete = { ...receipt, state: GlyphMutationReceiptState.APPLIED };
        this.receipts.set(mutation.operationId, complete);
        return { receipt: complete };
      }
      let snapshot = await this.read(targetPath);
      if (mutation.kind === GlyphFileMutationKind.RENAME && (await this.fileService.exists(source)))
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
      const complete = {
        ...receipt,
        state: GlyphMutationReceiptState.APPLIED,
        afterRevision: snapshot.contentRevision,
        appliedToken: snapshot.token,
      };
      this.receipts.set(mutation.operationId, complete);
      if (mutation.save === true) snapshot = await this.saveMutation(targetPath, snapshot.contentRevision);
      return { snapshot, receipt: complete };
    } finally {
      changed?.dispose();
      this.pendingMutations.delete(cancellation);
      cancellation.dispose();
    }
  }

  /**
   * Cancels prepared Bulk Edits when their authority is revoked. Receipts are
   * captured at the model change, before asynchronous completion can lose access
   * to the workspace. A repeated operation id never applies a second edit.
   */
  async apply(
    mutation: GlyphTextMutation,
  ): Promise<{ snapshot: GlyphEditorTextSnapshot; receipt: GlyphMutationReceipt }> {
    const known = this.receipts.get(mutation.operationId);
    if (known) {
      if (known.state === GlyphMutationReceiptState.UNKNOWN)
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
      let snapshot = await this.read(mutation.path);
      if (mutation.save === true) {
        if (snapshot.contentRevision !== known.afterRevision)
          throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
        snapshot = await this.saveMutation(mutation.path, snapshot.contentRevision);
      }
      return { snapshot, receipt: known };
    }
    const resource = this.resolve(mutation.path);
    // Own a reference until settlement: invalidating cached read capabilities
    // must not dispose a model while Bulk Edit is still using it.
    const reference = await this.textModelService.createModelReference(resource);
    const cancellation = new CancellationTokenSource();
    this.pendingMutations.add(cancellation);
    try {
      const model = reference.object.textEditorModel;
      const before = await this.snapshot(mutation.path, model);
      if (
        before.token.workspaceGeneration !== this.workspaceGeneration ||
        !areSameTokens(before.token, mutation.expectedToken) ||
        before.contentRevision !== mutation.expectedContentRevision
      ) {
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
      }
      if (before.byteOrderMark !== mutation.byteOrderMark) {
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE);
      }
      const endings = mutation.text.match(/\r\n|\r|\n/gu);
      const uniformEnding =
        endings !== null && endings.length > 0 && endings.every(ending => ending === endings[0])
          ? endings[0]
          : undefined;
      const requestedEol =
        uniformEnding === '\n' ? EndOfLineSequence.LF : uniformEnding === '\r\n' ? EndOfLineSequence.CRLF : undefined;
      const appliedText = mutation.text.replaceAll(
        /\r\n|\r|\n/gu,
        requestedEol === undefined ? model.getEOL() : uniformEnding!,
      );
      // Mixed endings cannot express an EOL-only conversion in a text model.
      if (mutation.text !== before.text && appliedText === before.text)
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE);
      const replacementText = mutation.text.replaceAll(/\r\n|\r|\n/gu, model.getEOL());
      // Code OSS stores text offsets using the current EOL. Combining text and
      // EOL in one stack element corrupts those offsets on Undo. Use separate
      // version-guarded elements in the same undo group for this case.
      const separateEol =
        requestedEol !== undefined && uniformEnding !== model.getEOL() && replacementText !== before.text;
      const textEdit = {
        ...(replacementText === before.text
          ? { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '' }
          : { range: model.getFullModelRange(), text: replacementText }),
        ...(requestedEol === undefined || separateEol ? {} : { eol: requestedEol }),
      };
      const afterRevision = await sha256(appliedText, mutation.byteOrderMark);
      // Hashing yields to the renderer. Recheck trust immediately before the
      // edit, since a trust change can invalidate the earlier RPC authorization.
      if (!this.trustService.isWorkspaceTrusted()) {
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE);
      }
      this.assertWorkspaceBinding();
      if (before.token.workspaceGeneration !== this.workspaceGeneration)
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
      const reason = EditSources.unknown({ name: `glyph.applyEdit:${mutation.operationId}` });
      let observed: GlyphMutationReceipt | undefined;
      const receiptWrites: Promise<void>[] = [];
      const observe = (state: GlyphMutationReceiptState, revision?: string): GlyphMutationReceipt => {
        return {
          operationId: mutation.operationId,
          state,
          beforeRevision: before.contentRevision,
          ...(revision === undefined ? {} : { afterRevision: revision }),
          appliedToken: { ...before.token, version: model.getVersionId() },
          observedAt: new Date().toISOString(),
        };
      };
      let lastAttributedVersion = before.token.version;
      let foreignChange = false;
      let pendingEolVersion: number | undefined;
      const changed = model.onDidChangeContent(event => {
        if (model.getVersionId() === before.token.version) return;
        // EOL events have no source reason. Keep their receipt uncertain until
        // Bulk Edit succeeds; a competing user EOL change can invalidate its guard.
        const attributed = event.detailedReasons.includes(reason);
        const expectedEolChange =
          !foreignChange &&
          event.isEolChange &&
          requestedEol !== undefined &&
          model.getVersionId() === lastAttributedVersion + 1 &&
          model.getValue() === appliedText;
        if (attributed) lastAttributedVersion = model.getVersionId();
        else if (expectedEolChange) pendingEolVersion = model.getVersionId();
        else {
          foreignChange = true;
          pendingEolVersion = undefined;
        }
        const receipt = observe(
          attributed && !separateEol ? GlyphMutationReceiptState.APPLIED : GlyphMutationReceiptState.UNKNOWN,
        );
        // Capture bytes and version together at the real edit boundary. Code OSS
        // can normalize more than newlines (for example trim automatic whitespace),
        // so the requested replacement is not an authoritative post-edit snapshot.
        const text = model.getValue();
        const byteOrderMark = model.getValue(undefined, true).length > text.length;
        if (attributed || expectedEolChange) this.receipts.set(mutation.operationId, receipt);
        else observed = receipt;
        receiptWrites.push(
          sha256(text, byteOrderMark).then(revision => {
            const complete = { ...receipt, afterRevision: revision };
            // An older hash finishing late must not overwrite a newer observation.
            if (this.receipts.get(mutation.operationId) === receipt) this.receipts.set(mutation.operationId, complete);
            if (observed === receipt) observed = complete;
          }),
        );
      });
      try {
        const options = {
          label: 'Apply Glyph edit',
          code: 'glyph.applyEdit',
          undoRedoGroupId: this.undoGroup(mutation.undoGroupId).id,
          respectAutoSaveConfig: true,
          token: cancellation.token,
          reason,
        };
        const apply = async (edits: ResourceTextEdit[]) => {
          if (!separateEol) return this.bulkEditService.apply(edits, options);
          // BulkEditService only reuses IDs from currently active calls. The
          // native text-edit primitive accepts our actual group across both calls.
          const operation = this.instantiationService.createInstance(
            BulkTextEdits,
            options.label,
            options.code,
            undefined,
            this.undoGroup(mutation.undoGroupId),
            undefined,
            Progress.None,
            cancellation.token,
            edits,
          );
          return { isApplied: (await operation.apply(reason)).length > 0 };
        };
        let result = await apply([
          // The inner object is Code OSS's ITextEdit data shape; ResourceTextEdit
          // supplies the resource/version class wrapper required by Bulk Edit.
          new ResourceTextEdit(
            resource,
            textEdit,
            before.token.version,
            /[\u{10000}-\u{10FFFF}\uD800-\uDFFF]/u.test(before.text)
              ? { label: options.label, needsConfirmation: false }
              : undefined,
          ),
        ]);
        if (separateEol) {
          this.assertWorkspaceBinding();
          if (!this.trustService.isWorkspaceTrusted())
            throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE);
          if (
            !result.isApplied ||
            cancellation.token.isCancellationRequested ||
            foreignChange ||
            model.getVersionId() !== lastAttributedVersion
          )
            throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
          result = await apply([
            new ResourceTextEdit(
              resource,
              {
                range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
                text: '',
                eol: requestedEol,
              },
              lastAttributedVersion,
            ),
          ]);
        }
        await Promise.all(receiptWrites);
        const eolReceipt = this.receipts.get(mutation.operationId);
        if (
          result.isApplied &&
          !cancellation.token.isCancellationRequested &&
          pendingEolVersion !== undefined &&
          eolReceipt?.appliedToken?.version === pendingEolVersion &&
          model.getVersionId() === pendingEolVersion
        )
          this.receipts.set(mutation.operationId, { ...eolReceipt, state: GlyphMutationReceiptState.APPLIED });
        // Upstream's isApplied describes a nonempty edit list, even when its
        // cancellation check skipped every write. Only an observed change (or
        // a successful no-op) is evidence for an applied receipt.
        if (
          result.isApplied &&
          !cancellation.token.isCancellationRequested &&
          before.contentRevision === afterRevision &&
          model.getVersionId() === before.token.version
        ) {
          this.receipts.set(mutation.operationId, observe(GlyphMutationReceiptState.APPLIED, afterRevision));
        }
        if (result.isApplied && observed && !this.receipts.has(mutation.operationId)) {
          this.receipts.set(mutation.operationId, {
            ...observed,
            state: cancellation.token.isCancellationRequested
              ? GlyphMutationReceiptState.UNKNOWN
              : GlyphMutationReceiptState.APPLIED,
          });
        }
        this.assertWorkspaceBinding();
        const receipt = this.receipts.get(mutation.operationId);
        if (!receipt || receipt.state === GlyphMutationReceiptState.UNKNOWN) {
          throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
        }
        let snapshot = await this.snapshot(mutation.path, model);
        if (mutation.save === true) snapshot = await this.saveMutation(mutation.path, snapshot.contentRevision);
        return { snapshot, receipt };
      } finally {
        changed.dispose();
        await Promise.all(receiptWrites);
        if (observed && cancellation.token.isCancellationRequested && !this.receipts.has(mutation.operationId)) {
          this.receipts.set(mutation.operationId, observed);
        }
      }
    } finally {
      this.pendingMutations.delete(cancellation);
      cancellation.dispose();
      reference.dispose();
    }
  }

  /** Supports recovery when an apply result was lost after the side effect completed. */
  async inspectReceipt(operationId: string): Promise<GlyphMutationReceipt | undefined> {
    return this.receipts.get(operationId);
  }

  /** Save only the changed resource; skip formatters that would escape the recorded edit. */
  private async saveMutation(path: string, expectedRevision: string): Promise<GlyphEditorTextSnapshot> {
    this.assertWorkspaceBinding();
    if (!this.trustService.isWorkspaceTrusted())
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE);
    const resource = this.resolve(path);
    const current = await this.read(path);
    if (current.contentRevision !== expectedRevision)
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
    if (this.textFileService.isDirty(resource)) {
      const saved = await this.textFileService.save(resource, { skipSaveParticipants: true });
      if (!saved || this.textFileService.isDirty(resource))
        throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT, {
          reason: 'The edit changed the working copy but could not be saved. Save it before running commands.',
        });
    }
    const saved = await this.read(path);
    if (saved.contentRevision !== expectedRevision)
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
    return saved;
  }

  private async workingCopies(): Promise<readonly GlyphEditorTextSnapshot[]> {
    const models = this.modelService
      .getModels()
      .filter(model => model.uri.scheme === 'file' && this.workspaceContextService.isInsideWorkspace(model.uri));
    return Promise.all(models.map(model => this.snapshot(this.pathFor(model.uri), model)));
  }

  /** Unsaved live models occupy a target too, without resolving or reading new models. */
  private async exists(path: string): Promise<boolean> {
    const resource = this.resolve(path);
    const exists =
      (this.modelService.getModel(resource) !== null &&
        (!this.removedResources.has(resource.toString()) || this.textFileService.isDirty(resource))) ||
      (await this.fileService.exists(resource));
    this.assertWorkspaceBinding();
    if (!this.trustService.isWorkspaceTrusted())
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE);
    return exists;
  }

  /** Search the same live text that reads return, including unsaved edits. */
  private async searchWorkingCopies(
    request: Extract<GlyphEditorRequest, { type: GlyphEditorRequestType.SEARCH_WORKING_COPIES }>,
  ): Promise<GlyphEditorResponse> {
    const { operationId } = request;
    const snapshots = await this.workingCopies();
    const matches: GlyphWorkingCopySearchMatch[] = [];
    const pattern =
      request.options.patternKind === GlyphWorkingCopyPatternKind.LITERAL
        ? request.pattern.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
        : request.pattern;
    const regex = new RegExp(
      pattern,
      `g${request.options.caseSensitive ? '' : 'i'}${request.options.multiline ? 'ms' : 'm'}`,
    );
    const limit = Math.min(Math.max(request.options.limit, 1), 1000);
    for (const snapshot of snapshots) {
      for (const match of snapshot.text.matchAll(regex)) {
        if (matches.length >= limit) return { operationId, ok: true, search: { matches, truncated: true } };
        const before = snapshot.text.slice(0, match.index).split('\n');
        const through = snapshot.text.slice(0, match.index + match[0].length).split('\n');
        matches.push({
          path: snapshot.path,
          line: before.length,
          column: before.at(-1)!.length + 1,
          endLine: through.length,
          endColumn: through.at(-1)!.length + 1,
          lineText: snapshot.text.split('\n')[before.length - 1],
          matchedText: match[0],
        });
      }
    }
    return { operationId, ok: true, search: { matches, truncated: false } };
  }

  private errorCode(error: unknown): GlyphDesktopErrorCode {
    if (error instanceof GlyphEditorAdapterError) return error.code;
    // A resource becoming non-text is a stale review, not a broken transport.
    // Keep permission and unexpected failures fatal instead of treating them as
    // missing/unsupported files and allowing recovery to infer a completed edit.
    if (
      TextFileOperationError.isTextFileOperationError(error) &&
      error.textFileOperationResult === TextFileOperationResult.FILE_IS_BINARY
    ) {
      return GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE;
    }
    if (error instanceof Error) {
      switch (toFileOperationResult(error)) {
        case FileOperationResult.FILE_NOT_FOUND:
          return GlyphDesktopErrorCode.NOT_FOUND;
        case FileOperationResult.FILE_IS_DIRECTORY:
        case FileOperationResult.FILE_NOT_DIRECTORY:
        case FileOperationResult.FILE_TOO_LARGE:
          return GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE;
        default:
          break;
      }
    }
    return GlyphDesktopErrorCode.INTERNAL;
  }

  private resolve(path: string): URI {
    this.assertWorkspaceBinding();
    const folders = this.workspaceContextService.getWorkspace().folders.filter(folder => folder.uri.scheme === 'file');
    const segments = path.split('/');
    if (
      path.startsWith('/') ||
      path.includes('\\') ||
      segments.some(segment => !segment || segment === '..' || segment === '.') ||
      path.includes('\0')
    ) {
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE);
    }
    const rootName = folders.length > 1 ? segments.shift() : undefined;
    const roots = folders.map(folder => ({ name: folder.name, uri: folder.uri.toString() }));
    const folder =
      rootName !== undefined && rootName !== ''
        ? folders.find((_folder, index) => getGlyphWorkspaceRootId(roots[index], roots) === rootName)
        : folders[0];
    if (!folder || folder.uri.scheme !== 'file') {
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE);
    }
    // Match the model resolver's canonical identity before any cache, occupancy,
    // or byte-budget lookup. A dirty model is authoritative even when the caller
    // uses another spelling on a case-insensitive filesystem.
    const resource = this.uriIdentityService.asCanonicalUri(
      URI.joinPath(folder.uri, folders.length > 1 ? segments.join('/') : path),
    );
    if (!this.workspaceContextService.isInsideWorkspace(resource)) {
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE);
    }
    return resource;
  }

  private async snapshot(path: string, model: ITextModel, maxBytes?: number): Promise<GlyphEditorTextSnapshot> {
    this.assertWorkspaceBinding();
    // UTF-16 length is a lower bound on UTF-8 bytes, so reject oversized live
    // buffers before flattening them into strings or hashing their contents.
    if (maxBytes !== undefined) this.assertReadBudget(model.getValueLength(), maxBytes);
    // Capture the version before hashing yields so the token describes these bytes.
    const token = {
      workspaceGeneration: this.workspaceGeneration,
      resource: model.uri.toString(),
      incarnation: this.incarnation(model),
      version: model.getVersionId(),
    };
    // preserveBOM adds encoding metadata; a literal leading U+FEFF is already
    // part of getValue() and must remain document content, including in receipts.
    const text = model.getValue();
    const byteOrderMark = model.getValue(undefined, true).length > text.length;
    const bytes = new TextEncoder().encode(text);
    if (maxBytes !== undefined) this.assertReadBudget(bytes.byteLength + (byteOrderMark ? 3 : 0), maxBytes);
    const contentRevision = await sha256(text, byteOrderMark);
    this.assertWorkspaceBinding();
    return {
      uri: model.uri.toString(),
      path,
      text,
      byteOrderMark,
      contentRevision,
      byteLength: bytes.byteLength + (byteOrderMark ? 3 : 0),
      mode: 0o644,
      identity: model.uri.toString(),
      dirty: this.textFileService.isDirty(model.uri),
      token,
    };
  }

  private incarnation(model: ITextModel): string {
    let value = this.incarnations.get(model);
    if (value === undefined || value === '') {
      value = generateUuid();
      this.incarnations.set(model, value);
    }
    return value;
  }

  private assertReadBudget(actualBytes: number, maxBytes: number): void {
    if (actualBytes > maxBytes)
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED, { maxBytes, actualBytes });
  }

  private pathFor(resource: URI): string {
    this.assertWorkspaceBinding();
    const folder = this.workspaceContextService.getWorkspaceFolder(resource);
    if (!folder) throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE);
    const path = resource.path.slice(folder.uri.path.replace(/\/$/u, '').length + 1);
    const roots = this.workspaceContextService
      .getWorkspace()
      .folders.filter(candidate => candidate.uri.scheme === 'file')
      .map(candidate => ({ name: candidate.name, uri: candidate.uri.toString() }));
    const routingId = getGlyphWorkspaceRootId({ name: folder.name, uri: folder.uri.toString() }, roots);
    return roots.length > 1 ? `${routingId}/${path}` : path;
  }

  private async reference(resource: URI): Promise<Awaited<ReturnType<ITextModelService['createModelReference']>>> {
    const key = resource.toString();
    const known = this.references.get(key);
    if (known) return known;
    const generation = this.workspaceGeneration;
    const reference = await this.textModelService.createModelReference(resource);
    if (generation !== this.workspaceGeneration || this._store.isDisposed) {
      reference.dispose();
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.STALE_DOCUMENT);
    }
    const concurrent = this.references.get(key);
    if (concurrent) {
      reference.dispose();
      return concurrent;
    }
    this.references.set(key, reference);
    return reference;
  }

  private undoGroup(id: string): UndoRedoGroup {
    let group = this.undoGroups.get(id);
    if (!group) {
      group = new UndoRedoGroup();
      this.undoGroups.set(id, group);
    }
    return group;
  }

  private currentWorkspaceBinding(): string {
    const workspace = this.workspaceContextService.getWorkspace();
    return JSON.stringify([
      this.userDataProfileService.currentProfile.id,
      workspace.id,
      workspace.configuration?.toString(),
      workspace.folders.map(folder => [folder.name, folder.uri.toString()]),
    ]);
  }

  private assertWorkspaceBinding(): void {
    // Host paths use the namespace negotiated when this adapter was created.
    // Never reinterpret one under a different identity, root count, name, URI, or order.
    if (this.workspaceChanged || this.currentWorkspaceBinding() !== this.workspaceBinding) {
      this.workspaceChanged = true;
      this.invalidate();
      throw new GlyphEditorAdapterError(GlyphDesktopErrorCode.WORKSPACE_CHANGED);
    }
  }
}

function areSameTokens(left: GlyphDocumentToken, right: GlyphDocumentToken): boolean {
  return (
    left.workspaceGeneration === right.workspaceGeneration &&
    left.resource === right.resource &&
    left.incarnation === right.incarnation &&
    left.version === right.version
  );
}

async function sha256(text: string, byteOrderMark: boolean): Promise<string> {
  const textBytes = new TextEncoder().encode(text);
  const bytes = byteOrderMark ? Uint8Array.from([0xef, 0xbb, 0xbf, ...textBytes]) : textBytes;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
