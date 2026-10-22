import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import type { WorkspaceMutationOptions } from '#src/workspace/WorkspaceMutationOptions.js';
import { WorkspaceMutationConsistency } from '#src/workspace/WorkspaceMutationConsistency.js';
import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { WorkspaceReadOptions } from '#src/workspace/WorkspaceReadOptions.js';
import { WorkspaceReadLimitError } from '#src/workspace/WorkspaceReadLimitError.js';
import { assertWellFormedWorkspacePath } from '#src/workspace/assertWellFormedWorkspacePath.js';
import type { GlyphDocumentToken } from '#src/desktop/protocol/connection/GlyphDocumentToken.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';
import type { GlyphEditorTextSnapshot } from '#src/desktop/protocol/editor/GlyphEditorTextSnapshot.js';
import {
  GlyphMutationReceiptState,
  type GlyphMutationReceipt,
} from '#src/desktop/protocol/editor/GlyphMutationReceipt.js';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import { GlyphFileMutationKind, type GlyphFileMutation } from '#src/desktop/protocol/editor/GlyphFileMutation.js';
import type { EditorWorkspaceClient } from './EditorWorkspaceClient.ts';

interface CachedCapability {
  readonly token: GlyphDocumentToken;
  readonly byteOrderMark: boolean;
}

/**
 * Workspace port backed by live Code OSS text models. Content hashes remain
 * the editing-domain revision while document tokens stay ephemeral host
 * capabilities and are never persisted in proposal records.
 */
export class EditorWorkspaceTextStore implements WorkspaceTextStore {
  readonly mutationConsistency = WorkspaceMutationConsistency.ATOMIC_VERSIONED;
  /** Capabilities are memory-only so a persisted proposal can never replay stale editor authority. */
  private readonly capabilities = new Map<string, CachedCapability>();
  /** Receipts make a retried operation idempotent after a transport interruption. */
  private readonly receipts = new Map<string, GlyphMutationReceipt>();

  constructor(
    readonly root: string,
    readonly caseSensitive: boolean,
    private readonly client: EditorWorkspaceClient,
  ) {
    assertWellFormedWorkspacePath(root);
  }

  list(
    maxFiles: number,
    globPattern?: string,
    targetDirectory?: string,
  ): Promise<{ files: string[]; truncated: boolean }> {
    return this.client.listPaths(maxFiles, globPattern, targetDirectory);
  }

  normalizePath(input: string): string {
    assertWellFormedWorkspacePath(input);
    if (!input || isAbsolute(input) || input.includes('\0')) throw malformedPath(input);
    const candidate = resolve(this.root, input);
    const fromRoot = relative(resolve(this.root), candidate);
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw malformedPath(input);
    }
    return fromRoot.split(sep).join('/');
  }

  canonicalPath(input: string): Promise<string> {
    return this.client.canonicalPath(this.normalizePath(input));
  }

  async read(input: string, options: WorkspaceReadOptions = {}): Promise<WorkspaceTextSnapshot> {
    const path = this.normalizePath(input);
    const response = await this.client.request({
      type: GlyphEditorRequestType.READ_SNAPSHOT,
      operationId: randomUUID(),
      path,
      ...options,
    });
    const snapshot = requireSnapshot(response, path);
    return this.remember(snapshot);
  }

  async exists(input: string): Promise<boolean> {
    const path = this.normalizePath(input);
    const response = await this.client.request({
      type: GlyphEditorRequestType.EXISTS,
      operationId: randomUUID(),
      path,
    });
    if (!response.ok) throw responseError(response, path);
    if (typeof response.exists !== 'boolean') {
      throw new EditError(EditFailureReason.INCONSISTENT, 'The editor did not return path occupancy.', { path });
    }
    return response.exists;
  }

  async readOptional(input: string, options: WorkspaceReadOptions = {}): Promise<WorkspaceTextSnapshot | undefined> {
    const path = this.normalizePath(input);
    const response = await this.client.request({
      type: GlyphEditorRequestType.READ_SNAPSHOT,
      operationId: randomUUID(),
      path,
      ...options,
    });
    if (!response.ok && response.error?.code === GlyphDesktopErrorCode.NOT_FOUND) return undefined;
    return this.remember(requireSnapshot(response, path));
  }

  async create(
    path: string,
    text: string,
    byteOrderMark: boolean,
    _mode?: number,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceTextSnapshot> {
    const response = await this.mutateFile({
      kind: GlyphFileMutationKind.CREATE,
      path: this.normalizePath(path),
      text,
      byteOrderMark,
      operationId: options.operationId ?? randomUUID(),
      undoGroupId: options.undoGroupId ?? options.operationId ?? randomUUID(),
      ...(options.save === true ? { save: true } : {}),
    });
    return this.remember(requireSnapshot(response, path));
  }

  async rename(
    source: string,
    target: string,
    expectedRevision: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceTextSnapshot> {
    const recovered = await this.recoverFileMutation(source, expectedRevision, options.operationId, target);
    if (recovered && options.save !== true) return this.read(target);
    // A rename receipt proves the move, not a subsequent save. Replay its ID
    // through the renderer to finish saving without reading the removed source.
    const expectedToken = recovered
      ? await this.fileToken(target, (await this.read(target)).revision)
      : await this.fileToken(source, expectedRevision);
    const response = await this.mutateFile({
      kind: GlyphFileMutationKind.RENAME,
      path: this.normalizePath(source),
      target: this.normalizePath(target),
      expectedContentRevision: expectedRevision,
      expectedToken,
      operationId: options.operationId ?? randomUUID(),
      undoGroupId: options.undoGroupId ?? options.operationId ?? randomUUID(),
      ...(options.save === true ? { save: true } : {}),
    });
    return this.remember(requireSnapshot(response, target));
  }

  async delete(path: string, expectedRevision: string, options: WorkspaceMutationOptions = {}): Promise<void> {
    if (await this.recoverFileMutation(path, expectedRevision, options.operationId)) return;
    await this.mutateFile({
      kind: GlyphFileMutationKind.DELETE,
      path: this.normalizePath(path),
      expectedContentRevision: expectedRevision,
      expectedToken: await this.fileToken(path, expectedRevision),
      operationId: options.operationId ?? randomUUID(),
      undoGroupId: options.undoGroupId ?? options.operationId ?? randomUUID(),
      ...(options.save === true ? { save: true } : {}),
    });
  }

  async replace(
    input: string,
    expectedRevision: string,
    text: string,
    byteOrderMark: boolean,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceTextSnapshot> {
    // A content hash is durable proposal state; the token additionally proves the
    // same live editor incarnation survived between read and apply.
    const path = this.normalizePath(input);
    let capability = this.capabilities.get(capabilityKey(path, expectedRevision));
    if (!capability) {
      const current = await this.read(path);
      if (current.revision !== expectedRevision) throw stale(path, current.revision);
      capability = this.capabilities.get(capabilityKey(path, expectedRevision));
    }
    if (!capability) throw stale(path);
    if (capability.byteOrderMark !== byteOrderMark) {
      throw new EditError(EditFailureReason.UNSUPPORTED, 'Changing a document byte-order mark is not supported.', {
        path,
      });
    }
    const operationId = options.operationId ?? randomUUID();
    const knownReceipt = this.receipts.get(operationId);
    if (knownReceipt?.afterRevision !== undefined && knownReceipt?.afterRevision !== '' && options.save !== true) {
      const current = await this.read(path);
      if (current.revision === knownReceipt.afterRevision) return current;
      throw new EditError(EditFailureReason.INCONSISTENT, 'The mutation receipt no longer matches the working copy.', {
        path,
      });
    }
    const response = await this.client.request({
      type: GlyphEditorRequestType.APPLY_TEXT_MUTATION,
      mutation: {
        operationId,
        path,
        expectedContentRevision: expectedRevision,
        expectedToken: capability.token,
        text,
        byteOrderMark,
        undoGroupId: options.undoGroupId ?? operationId,
        ...(options.save === true ? { save: true } : {}),
      },
    });
    if (!response.ok) throw responseError(response, path);
    if (!response.receipt || !response.snapshot) {
      throw new EditError(EditFailureReason.INCONSISTENT, 'The editor returned an incomplete mutation result.', {
        path,
      });
    }
    this.receipts.set(operationId, response.receipt);
    if (options.save === true && response.snapshot.dirty)
      throw new EditError(EditFailureReason.INCONSISTENT, 'The editor applied the change but did not save it.', {
        path,
      });
    return this.remember(response.snapshot);
  }

  /** Invalidates every editor capability after reconnect, ownership transfer, or workspace change. */
  invalidateCapabilities(): void {
    this.capabilities.clear();
  }

  /** Inspect the renderer receipt before reading a source that the first attempt may have removed. */
  private async recoverFileMutation(
    source: string,
    revision: string,
    operationId?: string,
    target?: string,
  ): Promise<boolean> {
    if (operationId === undefined || operationId === '') return false;
    const response = await this.client.request({ type: GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT, operationId });
    if (!response.ok) throw responseError(response, source);
    const receipt = response.receipt;
    if (!receipt) return false;
    if (
      receipt.state !== GlyphMutationReceiptState.APPLIED ||
      receipt.beforeRevision !== revision ||
      (await this.exists(source))
    )
      throw stale(source);
    if (target !== undefined && target !== '' && (await this.read(target)).revision !== receipt.afterRevision)
      throw stale(target);
    return true;
  }

  private async fileToken(input: string, revision: string): Promise<GlyphDocumentToken> {
    const path = this.normalizePath(input);
    const snapshot = await this.read(path);
    if (snapshot.revision !== revision) throw stale(path, snapshot.revision);
    return this.capabilities.get(capabilityKey(path, revision))!.token;
  }

  private async mutateFile(mutation: GlyphFileMutation): Promise<GlyphEditorResponse> {
    const response = await this.client.request({ type: GlyphEditorRequestType.APPLY_FILE_MUTATION, mutation });
    if (!response.ok) throw responseError(response, mutation.path);
    if (!response.receipt)
      throw new EditError(EditFailureReason.INCONSISTENT, 'The editor did not confirm the file operation.', {
        path: mutation.path,
      });
    this.receipts.set(mutation.operationId, response.receipt);
    this.capabilities.clear();
    if (mutation.save === true && response.snapshot?.dirty === true)
      throw new EditError(EditFailureReason.INCONSISTENT, 'The editor applied the file change but did not save it.', {
        path: mutation.path,
      });
    return response;
  }

  private remember(snapshot: GlyphEditorTextSnapshot): WorkspaceTextSnapshot {
    const path = this.normalizePath(snapshot.path);
    const computedRevision = contentRevision(snapshot.text, snapshot.byteOrderMark);
    if (computedRevision !== snapshot.contentRevision) {
      throw new EditError(EditFailureReason.INCONSISTENT, 'The editor snapshot content hash is invalid.', { path });
    }
    // Never trust a renderer-supplied revision without recomputing it in the host.
    this.capabilities.set(capabilityKey(path, snapshot.contentRevision), {
      token: snapshot.token,
      byteOrderMark: snapshot.byteOrderMark,
    });
    return {
      path,
      text: snapshot.text,
      byteOrderMark: snapshot.byteOrderMark,
      revision: snapshot.contentRevision,
      byteLength: snapshot.byteLength,
      mode: snapshot.mode,
      identity: snapshot.identity,
    };
  }
}

/** Matches the renderer hash exactly, including the on-disk UTF-8 BOM when present. */
export function contentRevision(text: string, byteOrderMark: boolean): string {
  const hash = createHash('sha256');
  if (byteOrderMark) hash.update(Buffer.from([0xef, 0xbb, 0xbf]));
  return hash.update(text, 'utf8').digest('hex');
}

function requireSnapshot(response: GlyphEditorResponse, path: string): GlyphEditorTextSnapshot {
  if (!response.ok) throw responseError(response, path);
  if (!response.snapshot) {
    throw new EditError(EditFailureReason.INCONSISTENT, 'The editor did not return a text snapshot.', { path });
  }
  return response.snapshot;
}

/** Converts a wire-safe error DTO back into the editing domain's proper Error hierarchy. */
function responseError(response: GlyphEditorResponse, path: string): Error {
  const code = response.error?.code;
  if (code === GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED) {
    return new WorkspaceReadLimitError(
      path,
      Number(response.error?.details?.maxBytes),
      Number(response.error?.details?.actualBytes),
    );
  }
  const reason =
    code === GlyphDesktopErrorCode.STALE_DOCUMENT
      ? EditFailureReason.STALE
      : code === GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE
        ? EditFailureReason.UNSUPPORTED
        : EditFailureReason.INCONSISTENT;
  return new EditError(reason, response.error?.message ?? 'The editor workspace request failed.', { path });
}

function malformedPath(path: string): EditError {
  return new EditError(EditFailureReason.MALFORMED, 'Path must be a project-relative file path.', { path });
}

function stale(path: string, currentRevision?: string): EditError {
  return new EditError(EditFailureReason.STALE, 'The editor document changed after the proposal was staged.', {
    path,
    ...(currentRevision !== undefined && currentRevision !== '' ? { currentRevision } : {}),
    retry: 'Read the current working copy and submit a new proposal.',
  });
}

function capabilityKey(path: string, revision: string): string {
  return `${path}\0${revision}`;
}
