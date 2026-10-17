import { build } from 'esbuild';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let api;

beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        export { GlyphEditorAdapter } from './code-oss/overlay/src/vs/workbench/contrib/glyph/browser/GlyphEditorAdapter.ts';
        export { URI } from '#vs/base/common/uri.js';
        export { Event } from '#vs/base/common/event.js';
        export { UriIdentityService } from '#vs/platform/uriIdentity/common/uriIdentityService.js';
        export { FileOperationError, FileOperationResult } from '#vs/platform/files/common/files.js';
        export { TextFileOperationError, TextFileOperationResult } from '#vs/workbench/services/textfile/common/textfiles.js';
        export { EditorWorkspaceTextStore } from '#src/desktop/workspace/EditorWorkspaceTextStore.js';
        export { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
        export { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
        export { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
      `,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    plugins: [
      {
        name: 'pinned-editor-snapshot-services',
        setup(builder) {
          builder.onResolve({ filter: /^#vs\// }, args => {
            if (
              args.path.startsWith('#vs/base/') ||
              args.path.startsWith('#vs/platform/uriIdentity/') ||
              args.path === '#vs/platform/files/common/files.js' ||
              args.path === '#vs/workbench/services/textfile/common/textfiles.js'
            ) {
              return { path: resolve('.code-oss/src/src/vs', args.path.slice(4).replace(/\.js$/, '.ts')) };
            }
            return { path: args.path, namespace: 'services' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'services' }, () => ({
            loader: 'js',
            contents: `
              const service = () => {};
              export { service as IModelService, service as IWorkspaceTrustManagementService,
                service as IBulkEditService, service as ITextModelService, service as IWorkspaceContextService,
                service as IUserDataProfileService, service as IInstantiationService };
        export const Progress = { None: {} };
        export class BulkTextEdits {}
              export const EndOfLineSequence = { LF: 0, CRLF: 1 };
        export class ResourceTextEdit {
                constructor(resource, edit, version) { Object.assign(this, { resource, edit, version }); }
              }
              export class UndoRedoGroup { id = 1; }
              export const EditSources = { unknown: metadata => ({ metadata }) };
            `,
          }));
          builder.onResolve({ filter: /^#glyph\// }, args => ({
            path: resolve('src/desktop', args.path.slice(7).replace(/\.js$/, '.ts')),
          }));
          builder.onResolve({ filter: /^#src\// }, args => ({
            path: resolve('src', args.path.slice(5).replace(/\.js$/, '.ts')),
          }));
        },
      },
    ],
  });
  api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});

describe('Editor snapshot recovery', () => {
  it.each(
    ['binary', 'directory', 'parent is not a directory', 'too large'].flatMap(kind =>
      ['pending update', 'interrupted create', 'interrupted delete', 'interrupted rename'].map(phase => ({
        kind,
        phase,
      })),
    ),
  )('keeps $phase stale and rejectable when the pinned editor rejects a $kind snapshot', async ({ kind, phase }) => {
    const fixture = editorFixture();
    let stored = [];
    const store = {
      load: async () => structuredClone(stored),
      save: async proposals => {
        stored = structuredClone(proposals);
      },
      clear: async () => {
        stored = [];
      },
    };
    const workspace = new api.EditorWorkspaceTextStore('/workspace', false, {
      canonicalPath: async path => `/workspace/${path}`,
      listPaths: async () => ({ files: ['a.ts'], truncated: false }),
      request: request => fixture.adapter.handle(request),
    });
    try {
      const initial = await workspace.read('a.ts');
      const compiler = new api.EditProposalService(workspace, new api.JsDiffTextDiffer(), {
        maxRawProposalBytes: 1_048_576,
        maxChangedBytes: 1_048_576,
        maxResultingBytesPerFile: 1_048_576,
        maxFiles: 64,
        maxTotalHunks: 256,
        maxHunksPerFile: 64,
        diffBudgetMs: 1_000,
        maxActiveReviews: 8,
        newFileByteOrderMark: false,
        newFileLineEnding: '\n',
      });
      const proposal = await compiler.proposeStructured({
        files: [
          {
            operation: {
              'pending update': 'UPDATE',
              'interrupted create': 'CREATE',
              'interrupted delete': 'DELETE',
              'interrupted rename': 'RENAME',
            }[phase],
            path: phase === 'interrupted create' ? 'created.ts' : 'a.ts',
            new_path: phase === 'interrupted rename' ? 'renamed.ts' : null,
            base_revision: phase === 'interrupted create' ? null : initial.revision,
            content: ['pending update', 'interrupted create'].includes(phase) ? 'replacement' : null,
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      if (phase !== 'pending update') {
        proposal.files[0].applyingItemId = proposal.files[0].items[0].id;
        proposal.files[0].applicability = 'APPLYING';
      }
      await new api.ProposalReviewManager(workspace, store).stage(proposal);
      fixture.adapter.invalidate();
      const unresolved = fixture.resolveModel.getMockImplementation();
      fixture.resolveModel.mockImplementation(resource => {
        if (phase !== 'interrupted rename' || resource.path.endsWith('/renamed.ts')) throw editorError(kind);
        return unresolved(resource);
      });
      const recovered = new api.ProposalReviewManager(workspace, store);

      await expect(recovered.initialize()).resolves.toBeUndefined();
      expect(recovered.active.files[0].applicability).toBe('STALE');
      expect(recovered.active.files[0].items[0].decision).toBe('PENDING');
      expect(recovered.active.files[0].applyingItemId).toBeNull();
      await recovered.rejectAll();
      expect(recovered.pendingResults[0].items[0].decision).toBe('REJECTED');
      expect(fixture.apply).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    ['missing', 'NOT_FOUND'],
    ['permission denied', 'INTERNAL'],
    ['unknown', 'INTERNAL'],
  ])('does not mistake %s failures for recoverable unsupported contents', async (kind, code) => {
    const fixture = editorFixture();
    fixture.resolveModel.mockRejectedValue(editorError(kind));
    try {
      const response = await fixture.adapter.handle({ type: 'read_snapshot', operationId: 'read', path: 'a.ts' });
      expect(response).toMatchObject({ ok: false, error: { code } });
    } finally {
      fixture.dispose();
    }
  });
});

describe('Canonical editor snapshot identities', () => {
  it('reads alternate casing from the small dirty model without inspecting the larger disk file', async () => {
    const fixture = editorFixture({ diskSize: 8 * 1024 * 1024 });
    try {
      const read = path => fixture.adapter.handle({ type: 'read_snapshot', operationId: path, path, maxBytes: 4 });
      const original = await read('a.ts');
      const alternate = await read('A.TS');
      expect(original).toMatchObject({ ok: true, snapshot: { text: 'tiny', dirty: true } });
      expect(alternate).toMatchObject({ ok: true, snapshot: { text: 'tiny', dirty: true } });
      expect(alternate.snapshot.token).toEqual(original.snapshot.token);
      expect(fixture.stat).not.toHaveBeenCalled();
      expect(fixture.resolveModel).toHaveBeenCalledTimes(1);
      expect(fixture.resolveModel.mock.calls[0][0].path).toBe('/workspace/a.ts');
    } finally {
      fixture.dispose();
    }
  });

  it('recognizes a differently cased unsaved model as an occupied target without touching disk', async () => {
    const fixture = editorFixture();
    try {
      expect(await fixture.adapter.handle({ type: 'exists', operationId: 'exists', path: 'A.TS' })).toMatchObject({
        ok: true,
        exists: true,
      });
      expect(fixture.exists).not.toHaveBeenCalled();
      expect(fixture.resolveModel).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it('uses a read capability through alternate casing to edit the same canonical document', async () => {
    const fixture = editorFixture();
    try {
      const before = await fixture.adapter.read('a.ts', 4);
      const result = await fixture.adapter.handle({
        type: 'apply_text_mutation',
        mutation: {
          operationId: 'canonical-edit',
          path: 'A.TS',
          text: 'edited',
          byteOrderMark: false,
          undoGroupId: 'canonical-edit',
          expectedContentRevision: before.contentRevision,
          expectedToken: before.token,
        },
      });
      expect(result).toMatchObject({ ok: true, snapshot: { text: 'edited' }, receipt: { state: 'applied' } });
      expect(result.snapshot.token.resource).toBe(before.token.resource);
      expect(result.snapshot.token.incarnation).toBe(before.token.incarnation);
      expect(fixture.apply.mock.calls[0][0][0].resource.path).toBe('/workspace/a.ts');
      expect(fixture.resolveModel.mock.calls.every(([resource]) => resource.path === '/workspace/a.ts')).toBe(true);
      expect(fixture.stat).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it('keeps differently cased files distinct on a case-sensitive provider and bounds an unopened file', async () => {
    const fixture = editorFixture({ caseSensitive: true, diskSize: 8 * 1024 * 1024 });
    try {
      const response = await fixture.adapter.handle({
        type: 'read_snapshot',
        operationId: 'read',
        path: 'A.TS',
        maxBytes: 4,
      });
      expect(response).toMatchObject({ ok: false, error: { code: 'READ_LIMIT_EXCEEDED' } });
      expect(fixture.stat).toHaveBeenCalledTimes(1);
      expect(fixture.resolveModel).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it('does not reuse a capability for a distinct case-sensitive document', async () => {
    const fixture = editorFixture({ caseSensitive: true });
    try {
      const before = await fixture.adapter.read('a.ts', 4);
      const originalModel = fixture.resolveModel.getMockImplementation();
      fixture.resolveModel.mockImplementation(async resource => {
        const reference = await originalModel(resource);
        if (resource.path === '/workspace/A.TS') {
          return { ...reference, object: { textEditorModel: { ...reference.object.textEditorModel, uri: resource } } };
        }
        return reference;
      });
      const result = await fixture.adapter.handle({
        type: 'apply_text_mutation',
        mutation: {
          operationId: 'other-edit',
          path: 'A.TS',
          text: 'edited',
          byteOrderMark: false,
          undoGroupId: 'other-edit',
          expectedContentRevision: before.contentRevision,
          expectedToken: before.token,
        },
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'STALE_DOCUMENT' } });
      expect(fixture.apply).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it.each(['../a.ts', '/workspace/a.ts', 'sub/../a.ts'])('rejects %s before canonicalization', async path => {
    const fixture = editorFixture();
    const canonical = vi.spyOn(fixture.identity, 'asCanonicalUri');
    try {
      const response = await fixture.adapter.handle({ type: 'read_snapshot', operationId: 'read', path });
      expect(response).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_RESOURCE' } });
      expect(canonical).not.toHaveBeenCalled();
      expect(fixture.resolveModel).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });
});

function editorError(kind) {
  switch (kind) {
    case 'binary':
      return new api.TextFileOperationError('File is binary.', api.TextFileOperationResult.FILE_IS_BINARY);
    case 'directory':
      return new api.FileOperationError('File is a directory.', api.FileOperationResult.FILE_IS_DIRECTORY);
    case 'parent is not a directory':
      return new api.FileOperationError(
        'An ancestor is no longer a directory.',
        api.FileOperationResult.FILE_NOT_DIRECTORY,
      );
    case 'too large':
      return new api.FileOperationError('File exceeds the editor limit.', api.FileOperationResult.FILE_TOO_LARGE);
    case 'missing':
      return new api.FileOperationError('File is missing.', api.FileOperationResult.FILE_NOT_FOUND);
    case 'permission denied':
      return new api.FileOperationError('Permission denied.', api.FileOperationResult.FILE_PERMISSION_DENIED);
    default:
      return new Error('Unexpected model failure.');
  }
}

/** Uses the pinned URI identity service so casing follows provider capabilities, not the test OS. */
function editorFixture({ caseSensitive = false, diskSize = 4 } = {}) {
  const { URI, Event, UriIdentityService, GlyphEditorAdapter } = api;
  const root = { name: 'workspace', uri: URI.file('/workspace') };
  const stat = vi.fn(async () => ({ size: diskSize }));
  const exists = vi.fn(async () => false);
  const fileService = {
    hasProvider: () => true,
    hasCapability: () => caseSensitive,
    onDidChangeFileSystemProviderRegistrations: Event.None,
    onDidChangeFileSystemProviderCapabilities: Event.None,
    stat,
    exists,
  };
  const identity = new UriIdentityService(fileService);
  let text = 'tiny';
  let version = 1;
  const changeListeners = new Set();
  const model = {
    uri: identity.asCanonicalUri(URI.file('/workspace/a.ts')),
    getVersionId: () => version,
    getValue: () => text,
    getValueLength: () => text.length,
    getEOL: () => '\n',
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: text.length + 1 }),
    onDidChangeContent: listener => {
      changeListeners.add(listener);
      return { dispose: () => changeListeners.delete(listener) };
    },
  };
  const resolveModel = vi.fn(async () => ({ object: { textEditorModel: model }, dispose() {} }));
  const apply = vi.fn(async (edits, options) => {
    text = edits[0].edit.text;
    version++;
    for (const listener of changeListeners) listener({ detailedReasons: [options.reason] });
    return { isApplied: true };
  });
  const adapter = new GlyphEditorAdapter(
    { createModelReference: resolveModel },
    { apply },
    {
      getWorkspace: () => ({ id: 'workspace', folders: [root] }),
      getWorkspaceFolder: () => root,
      isInsideWorkspace: uri => uri.path.startsWith('/workspace/'),
      onDidChangeWorkspaceFolders: Event.None,
      onDidChangeWorkspaceName: Event.None,
      onDidChangeWorkbenchState: Event.None,
    },
    { getModel: uri => (uri.toString() === model.uri.toString() ? model : null) },
    { isDirty: () => true },
    { isWorkspaceTrusted: () => true },
    fileService,
    identity,
    { currentProfile: { id: 'profile' }, onDidChangeCurrentProfile: Event.None },
  );
  return {
    adapter,
    identity,
    resolveModel,
    apply,
    stat,
    exists,
    dispose: () => {
      adapter.dispose();
      identity.dispose();
    },
  };
}
