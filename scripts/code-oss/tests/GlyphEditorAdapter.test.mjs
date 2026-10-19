import { build } from 'esbuild';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/** Real adapter, URI and lifecycle code; only injected workbench services are simulated. */
async function adapterModule() {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      export { GlyphEditorAdapter } from './code-oss/overlay/src/vs/workbench/contrib/glyph/browser/GlyphEditorAdapter.ts';
      export { URI } from '#vs/base/common/uri.js';
    `,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    plugins: [
      {
        name: 'editor-fixture-services',
        setup(builder) {
          builder.onResolve({ filter: /^#vs\// }, args => {
            if (
              args.path.startsWith('#vs/base/') ||
              args.path === '#vs/platform/files/common/files.js' ||
              args.path === '#vs/workbench/services/textfile/common/textfiles.js'
            )
              return { path: resolve('.code-oss/src/src/vs', args.path.slice(4).replace(/\.js$/, '.ts')) };
            return { path: args.path, namespace: 'services' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'services' }, () => ({
            loader: 'js',
            contents: `
        const service = () => {};
        export { service as IModelService,
          service as IWorkspaceTrustManagementService, service as IBulkEditService,
          service as ITextModelService, service as IWorkspaceContextService, service as IUriIdentityService,
          service as IUserDataProfileService, service as IInstantiationService };
        export const Progress = { None: {} };
        export class BulkTextEdits {}
        export const EndOfLineSequence = { LF: 0, CRLF: 1 };
        export class ResourceFileEdit { constructor(oldResource, newResource, options) { Object.assign(this, { oldResource, newResource, options }); } }
        export class ResourceTextEdit { constructor(resource, edit, version) { Object.assign(this, { resource, edit, version }); } }
        export class UndoRedoGroup { id = 1; }
        export const UNDO_REDO_SOURCE = { id: 1 };
        export const EditSources = { unknown: metadata => ({ metadata }) };
      `,
          }));
          builder.onResolve({ filter: /^#glyph\// }, args => ({
            path: resolve('src/desktop', args.path.slice(7).replace(/\.js$/, '.ts')),
          }));
        },
      },
    ],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

describe('Editor workspace binding', () => {
  it.each(['disk', 'live', 'missing', 'revoked', 'folders changed'])(
    'checks %s target occupancy without reading or resolving text',
    async kind => {
      const { GlyphEditorAdapter, URI } = await adapterModule();
      const root = { name: 'workspace', uri: URI.file('/workspace') };
      let folders = [root];
      let trusted = true;
      const resolveModel = vi.fn(() => {
        throw new Error('Occupancy must not load contents');
      });
      const exists = vi.fn(async () => {
        if (kind === 'revoked') trusted = false;
        if (kind === 'folders changed') folders = [{ name: 'other', uri: URI.file('/other') }];
        return kind !== 'missing';
      });
      const adapter = new GlyphEditorAdapter(
        { createModelReference: resolveModel },
        {},
        {
          getWorkspace: () => ({ id: 'workspace', folders }),
          getWorkspaceFolder: () => root,
          isInsideWorkspace: () => true,
          onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
          onDidChangeWorkspaceName: () => ({ dispose() {} }),
          onDidChangeWorkbenchState: () => ({ dispose() {} }),
        },
        { getModel: () => (kind === 'live' ? {} : null) },
        {},
        { isWorkspaceTrusted: () => trusted },
        { exists },
        { asCanonicalUri: resource => resource },
        { currentProfile: { id: 'profile' }, onDidChangeCurrentProfile: () => ({ dispose() {} }) },
      );
      try {
        const response = await adapter.handle({ type: 'exists', path: 'target.txt', operationId: 'occupancy' });
        if (kind === 'revoked') expect(response.error.code).toBe('UNTRUSTED_WORKSPACE');
        else if (kind === 'folders changed') expect(response.error.code).toBe('WORKSPACE_CHANGED');
        else expect(response).toMatchObject({ ok: true, exists: kind !== 'missing' });
        expect(resolveModel).not.toHaveBeenCalled();
        if (kind === 'live') expect(exists).not.toHaveBeenCalled();
      } finally {
        adapter.dispose();
      }
    },
  );
  it.each([
    ['A', 'A/B'],
    ['app', 'app'],
  ])('round-trips distinct files when folder display names are %s and %s', async (first, second) => {
    const { GlyphEditorAdapter, URI } = await adapterModule();
    const folders = [
      { name: first, uri: URI.file('/workspace/one') },
      { name: second, uri: URI.file('/workspace/two') },
    ];
    const models = ['/workspace/one/B/file.ts', '/workspace/two/file.ts'].map(path => ({
      uri: URI.file(path),
      getVersionId: () => 1,
      getValue: () => path,
      getValueLength: () => path.length,
    }));
    const adapter = new GlyphEditorAdapter(
      {
        createModelReference: async uri => {
          const model = models.find(value => value.uri.toString() === uri.toString());
          if (!model) throw new Error(`Wrong route: ${uri}`);
          return { object: { textEditorModel: model }, dispose() {} };
        },
      },
      {},
      {
        getWorkspace: () => ({ id: 'workspace', folders }),
        getWorkspaceFolder: uri => folders.find(folder => uri.path.startsWith(`${folder.uri.path}/`)),
        isInsideWorkspace: () => true,
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
        onDidChangeWorkspaceName: () => ({ dispose() {} }),
        onDidChangeWorkbenchState: () => ({ dispose() {} }),
      },
      { getModels: () => models },
      { isDirty: () => true },
      { isWorkspaceTrusted: () => true },
      {},
      { asCanonicalUri: resource => resource },
      { currentProfile: { id: 'profile' }, onDidChangeCurrentProfile: () => ({ dispose() {} }) },
    );
    try {
      const response = await adapter.handle({ type: 'list_working_copies', operationId: 'list' });
      expect(response.ok).toBe(true);
      expect(new Set(response.workingCopies.map(copy => copy.path)).size).toBe(2);
      for (const copy of response.workingCopies) expect((await adapter.read(copy.path)).uri).toBe(copy.uri);
    } finally {
      adapter.dispose();
    }
  });
  it('applies an explicit EOL-only conversion and records its final bytes', async () => {
    const edit = await pendingEdit({ initial: 'line\n', replacement: 'line\r\n' });
    edit.write.resolve();
    edit.finish.resolve();
    try {
      const response = await edit.apply();
      expect(response.ok).toBe(true);
      expect(edit.text()).toBe('line\r\n');
      expect(response.receipt.state).toBe('applied');
      expect(response.receipt.afterRevision).toBe(response.snapshot.contentRevision);
    } finally {
      edit.adapter.dispose();
    }
  });
  it('uses separately guarded text and EOL edits in one undo group', async () => {
    const edit = await pendingEdit({ initial: 'line\n', replacement: 'LINE\r\n' });
    edit.write.resolve();
    edit.finish.resolve();
    try {
      const response = await edit.apply();
      expect(response.ok).toBe(true);
      expect(edit.text()).toBe('LINE\r\n');
      expect(edit.launch).toHaveBeenCalledTimes(2);
      const [text, eol] = edit.launch.mock.calls;
      expect(text[0][0].edit.eol).toBeUndefined();
      expect(eol[0][0].edit).toMatchObject({ text: '', eol: 1 });
      expect(text[1].undoRedoGroupId).toBe(eol[1].undoRedoGroupId);
      expect(eol[0][0].version).toBe(text[0][0].version + 1);
      expect(response.receipt.state).toBe('applied');
      expect(response.receipt.afterRevision).toBe(response.snapshot.contentRevision);
    } finally {
      edit.adapter.dispose();
    }
  });
  it('retains an uncertain receipt when the EOL step fails after changing text', async () => {
    const edit = await pendingEdit({ initial: 'line\n', replacement: 'LINE\r\n' });
    const apply = edit.launch.getMockImplementation();
    edit.launch.mockImplementationOnce(apply).mockImplementationOnce(async (...args) => {
      await apply(...args);
      throw new Error('EOL confirmation failed');
    });
    edit.write.resolve();
    edit.finish.resolve();
    try {
      expect((await edit.apply()).ok).toBe(false);
      expect(edit.text()).toBe('LINE\r\n');
      expect((await edit.adapter.inspectReceipt('edit'))?.state).toBe('unknown');
    } finally {
      edit.adapter.dispose();
    }
  });
  it('keeps an untagged EOL observation uncertain until Bulk Edit confirms the guarded operation', async () => {
    const edit = await pendingEdit({ initial: 'line\n', replacement: 'line\r\n', failAfterWrite: true });
    try {
      const applying = edit.apply();
      await edit.entered.promise;
      edit.write.resolve();
      await edit.written.promise;
      expect((await edit.adapter.inspectReceipt('edit'))?.state).toBe('unknown');
      edit.finish.resolve();
      expect((await applying).ok).toBe(false);
      expect((await edit.adapter.inspectReceipt('edit'))?.state).toBe('unknown');
    } finally {
      edit.adapter.dispose();
    }
  });
  it('refuses a mixed EOL conversion that the editor would normalize into an unchanged document', async () => {
    const edit = await pendingEdit({ initial: 'one\ntwo\n', replacement: 'one\r\ntwo\n' });
    edit.write.resolve();
    edit.finish.resolve();
    try {
      const response = await edit.apply();
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('UNSUPPORTED_RESOURCE');
      expect(edit.launch).not.toHaveBeenCalled();
      expect(await edit.adapter.inspectReceipt('edit')).toBeUndefined();
    } finally {
      edit.adapter.dispose();
    }
  });
  it.each([false, true])(
    'preserves literal leading U+FEFF (%s) and records automatic whitespace normalization',
    async literalPrefix => {
      const { GlyphEditorAdapter, URI } = await adapterModule();
      const built = await build({
        entryPoints: ['.code-oss/src/src/vs/editor/test/common/testTextModel.ts'],
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
        loader: { '.css': 'empty' },
      });
      const { createTextModel } = await import(
        `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
      );
      const resource = URI.file('/workspace/file.ts');
      const model = createTextModel('hello\n\nend', null, { trimAutoWhitespace: true }, resource);
      const prefix = literalPrefix ? '\uFEFF' : '';
      if (literalPrefix)
        model.pushEditOperations(
          null,
          [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: prefix }],
          () => null,
        );
      model.pushEditOperations(
        null,
        [
          {
            range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
            text: '    ',
            isAutoWhitespaceEdit: true,
          },
        ],
        () => null,
      );
      const adapter = new GlyphEditorAdapter(
        { createModelReference: async () => ({ object: { textEditorModel: model }, dispose() {} }) },
        {
          apply: async (_edits, options) => {
            // Bulk Edit minimizes a whole-document replacement in the active editor.
            model.pushEditOperations(
              null,
              [
                {
                  range: {
                    startLineNumber: 1,
                    startColumn: 1 + prefix.length,
                    endLineNumber: 1,
                    endColumn: 6 + prefix.length,
                  },
                  text: 'HELLO',
                },
              ],
              () => null,
              undefined,
              options.reason,
            );
            return { isApplied: true };
          },
        },
        {
          getWorkspace: () => ({ id: 'workspace', folders: [{ name: 'workspace', uri: URI.file('/workspace') }] }),
          isInsideWorkspace: () => true,
          onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
          onDidChangeWorkspaceName: () => ({ dispose() {} }),
          onDidChangeWorkbenchState: () => ({ dispose() {} }),
        },
        { getModels: () => [model] },
        { isDirty: () => true },
        { isWorkspaceTrusted: () => true },
        {},
        { asCanonicalUri: resource => resource },
        { currentProfile: { id: 'profile' }, onDidChangeCurrentProfile: () => ({ dispose() {} }) },
      );
      try {
        const before = await adapter.read('file.ts');
        expect(before.text).toBe(`${prefix}hello\n    \nend`);
        expect(before.byteOrderMark).toBe(false);
        const response = await adapter.handle({
          type: 'apply_text_mutation',
          mutation: {
            operationId: 'trim',
            path: 'file.ts',
            text: `${prefix}HELLO\n    \nend`,
            byteOrderMark: false,
            undoGroupId: 'trim',
            expectedContentRevision: before.contentRevision,
            expectedToken: before.token,
          },
        });
        expect(model.getValue()).toBe(`${prefix}HELLO\n\nend`);
        expect(response).toMatchObject({
          ok: true,
          snapshot: { text: `${prefix}HELLO\n\nend`, byteOrderMark: false },
          receipt: { state: 'applied' },
        });
        expect(response.receipt.afterRevision).toBe(response.snapshot.contentRevision);
        expect((await adapter.inspectReceipt('trim')).afterRevision).toBe(response.snapshot.contentRevision);
      } finally {
        adapter.dispose();
        model.dispose();
      }
    },
  );

  it('does not claim an unrelated matching user edit when Bulk Edit rejects its stale version', async () => {
    const fixture = await pendingEdit({ sourceTagged: false, failAfterWrite: true });
    try {
      fixture.write.resolve();
      fixture.finish.resolve();
      expect((await fixture.apply()).ok).toBe(false);
      expect(fixture.text()).toBe('replacement');
      expect(await fixture.adapter.inspectReceipt('edit')).toBeUndefined();
    } finally {
      fixture.adapter.dispose();
    }
  });

  it.each([false, true])(
    'preserves uncertain evidence when a cancelled fallback loses the edit source, including failure: %s',
    async failAfterWrite => {
      const fixture = await pendingEdit({ sourceTagged: false, failAfterWrite });
      try {
        const applying = fixture.apply();
        await fixture.entered.promise;
        fixture.write.resolve();
        await fixture.written.promise;
        fixture.removeFolder();
        fixture.finish.resolve();
        expect(await applying).toMatchObject({ ok: false, receipt: { state: 'unknown' } });
        expect(await fixture.adapter.inspectReceipt('edit')).toMatchObject({ state: 'unknown' });
      } finally {
        fixture.adapter.dispose();
      }
    },
  );

  it('records a successful no-op without inventing a model change', async () => {
    const fixture = await pendingEdit({ replacement: 'original' });
    try {
      fixture.write.resolve();
      fixture.finish.resolve();
      const response = await fixture.apply();
      expect(response).toMatchObject({
        ok: true,
        receipt: {
          state: 'applied',
          beforeRevision: fixture.before.contentRevision,
          afterRevision: fixture.before.contentRevision,
          appliedToken: fixture.before.token,
        },
      });
    } finally {
      fixture.adapter.dispose();
    }
  });

  it('records the requested uniform newline convention in an applied receipt', async () => {
    const fixture = await pendingEdit({ eol: '\r\n', replacement: 'first\nsecond' });
    try {
      fixture.write.resolve();
      fixture.finish.resolve();
      const response = await fixture.apply();
      expect(response).toMatchObject({
        ok: true,
        snapshot: { text: 'first\nsecond' },
        receipt: { state: 'applied' },
      });
      expect(response.receipt.afterRevision).toBe(response.snapshot.contentRevision);
    } finally {
      fixture.adapter.dispose();
    }
  });

  it('returns an applied receipt for a completed edit and never reapplies its operation id', async () => {
    const fixture = await pendingEdit();
    try {
      fixture.write.resolve();
      fixture.finish.resolve();
      const response = await fixture.apply();
      expect(response).toMatchObject({ ok: true, snapshot: { text: 'replacement' }, receipt: { state: 'applied' } });
      expect((await fixture.apply()).receipt).toEqual(response.receipt);
      expect(fixture.launch).toHaveBeenCalledTimes(1);
    } finally {
      fixture.adapter.dispose();
    }
  });

  it.each(['invalidate', 'dispose'])('cancels a queued edit when the adapter receives %s', async operation => {
    const fixture = await pendingEdit();
    try {
      const applying = fixture.apply();
      await fixture.entered.promise;
      fixture.adapter[operation]();
      fixture.write.resolve();
      fixture.finish.resolve();
      expect((await applying).ok).toBe(false);
      expect(fixture.text()).toBe('original');
      expect(await fixture.adapter.inspectReceipt('edit')).toBeUndefined();
    } finally {
      fixture.adapter.dispose();
    }
  });

  it('cancels a prepared edit when its folder is removed before the model write', async () => {
    const fixture = await pendingEdit();
    try {
      const applying = fixture.apply();
      await fixture.entered.promise;
      fixture.removeFolder();
      fixture.write.resolve();
      fixture.finish.resolve();
      const result = await applying;
      expect.soft(fixture.text()).toBe('original');
      expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_CHANGED' } });
      expect(await fixture.adapter.inspectReceipt('edit')).toBeUndefined();
    } finally {
      fixture.adapter.dispose();
    }
  });

  it.each(['name', 'state', 'configuration', 'profile'])(
    'cancels a prepared edit when the session %s changes without changing its folders',
    async change => {
      const fixture = await pendingEdit();
      try {
        const applying = fixture.apply();
        await fixture.entered.promise;
        fixture.changeWorkspace(change);
        fixture.write.resolve();
        fixture.finish.resolve();
        const result = await applying;
        expect.soft(fixture.text()).toBe('original');
        expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_CHANGED' } });
        expect(await fixture.adapter.inspectReceipt('edit')).toBeUndefined();
      } finally {
        fixture.adapter.dispose();
      }
    },
  );

  it.each(['name', 'state', 'configuration', 'profile'])(
    'keeps completed edit evidence inspectable when the session %s changes before the reply',
    async change => {
      const fixture = await pendingEdit();
      try {
        const applying = fixture.apply();
        await fixture.entered.promise;
        fixture.write.resolve();
        await fixture.written.promise;
        fixture.changeWorkspace(change);
        fixture.finish.resolve();
        expect(await applying).toMatchObject({
          ok: false,
          error: { code: 'WORKSPACE_CHANGED' },
          receipt: { state: 'applied' },
        });
        expect(fixture.text()).toBe('replacement');
        expect(await fixture.adapter.handle({ type: 'inspect_mutation_receipt', operationId: 'edit' })).toMatchObject({
          ok: true,
          receipt: { operationId: 'edit', state: 'applied', beforeRevision: fixture.before.contentRevision },
        });
      } finally {
        fixture.adapter.dispose();
      }
    },
  );

  it.each(['display', 'profile metadata'])(
    'preserves an edit when a %s event does not change its binding',
    async change => {
      const fixture = await pendingEdit();
      try {
        const applying = fixture.apply();
        await fixture.entered.promise;
        fixture.changeWorkspace(change);
        fixture.write.resolve();
        fixture.finish.resolve();
        expect(await applying).toMatchObject({ ok: true, receipt: { state: 'applied' } });
        expect(fixture.text()).toBe('replacement');
      } finally {
        fixture.adapter.dispose();
      }
    },
  );

  it('rejects editor operations under a changed profile before its notification arrives', async () => {
    const fixture = await pendingEdit();
    try {
      fixture.changeWorkspace('profile pending notification');
      fixture.write.resolve();
      fixture.finish.resolve();
      const response = await fixture.apply();
      expect(response).toMatchObject({ ok: false, error: { code: 'WORKSPACE_CHANGED' } });
      expect(fixture.launch).not.toHaveBeenCalled();
      expect(fixture.text()).toBe('original');
    } finally {
      fixture.write.resolve();
      fixture.finish.resolve();
      fixture.adapter.dispose();
    }
  });

  it('retains an applied receipt when a folder is removed after the write but before Bulk Edit returns', async () => {
    const fixture = await pendingEdit();
    try {
      const applying = fixture.apply();
      await fixture.entered.promise;
      fixture.write.resolve();
      await fixture.written.promise;
      fixture.removeFolder();
      fixture.finish.resolve();
      expect(await applying).toMatchObject({
        ok: false,
        error: { code: 'WORKSPACE_CHANGED' },
        receipt: { state: 'applied' },
      });
      expect(fixture.text()).toBe('replacement');
      expect(await fixture.adapter.handle({ type: 'inspect_mutation_receipt', operationId: 'edit' })).toMatchObject({
        ok: true,
        receipt: { operationId: 'edit', state: 'applied', beforeRevision: fixture.before.contentRevision },
      });
    } finally {
      fixture.adapter.dispose();
    }
  });

  it('refuses old host paths after folder removal instead of reading or editing a nested namesake', async () => {
    const { GlyphEditorAdapter, URI } = await adapterModule();
    let folders = ['A', 'B'].map(name => ({ name, uri: URI.file(`/workspace/${name}`) }));
    const listeners = new Set();
    const workspace = {
      getWorkspace: () => ({ folders }),
      isInsideWorkspace: () => true,
      onDidChangeWorkspaceFolders: callback => {
        listeners.add(callback);
        return { dispose: () => listeners.delete(callback) };
      },
      onDidChangeWorkspaceName: () => ({ dispose() {} }),
      onDidChangeWorkbenchState: () => ({ dispose() {} }),
    };
    const reference = vi.fn(async uri => ({
      object: {
        textEditorModel: {
          uri,
          getVersionId: () => 1,
          getValue: () => uri.path,
          getValueLength: () => uri.path.length,
        },
      },
      dispose() {},
    }));
    const apply = vi.fn();
    const adapter = new GlyphEditorAdapter(
      { createModelReference: reference },
      { apply },
      workspace,
      { getModels: () => [] },
      { isDirty: () => true },
      { isWorkspaceTrusted: () => true },
      {},
      { asCanonicalUri: resource => resource },
      { currentProfile: { id: 'profile' }, onDidChangeCurrentProfile: () => ({ dispose() {} }) },
    );
    try {
      const before = await adapter.read('A/file.ts');
      expect(before.text).toBe('/workspace/A/file.ts');
      folders = folders.slice(0, 1);
      for (const listener of listeners) listener({ added: [], removed: [{ name: 'B' }], changed: [] });
      const read = await adapter.handle({ type: 'read_snapshot', operationId: 'read', path: 'A/file.ts' });
      const mutation = await adapter.handle({
        type: 'apply_text_mutation',
        mutation: {
          operationId: 'edit',
          path: 'A/file.ts',
          text: 'changed',
          byteOrderMark: false,
          undoGroupId: 'edit',
          expectedContentRevision: before.contentRevision,
          expectedToken: before.token,
        },
      });
      expect.soft(read.ok).toBe(false);
      expect.soft(read.error?.code).toBe('WORKSPACE_CHANGED');
      expect.soft(reference.mock.calls.map(([uri]) => uri.path)).toEqual(['/workspace/A/file.ts']);
      expect(mutation.ok).toBe(false);
      expect(mutation.error?.code).toBe('WORKSPACE_CHANGED');
      expect(apply).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
    }
  });
});

/** Gates preparation and completion separately, matching Bulk Edit's cancellation boundary. */
async function pendingEdit({
  initial = 'original',
  eol = '\n',
  replacement = 'replacement',
  sourceTagged = true,
  failAfterWrite = false,
} = {}) {
  const { GlyphEditorAdapter, URI } = await adapterModule();
  const entered = Promise.withResolvers();
  const write = Promise.withResolvers();
  const written = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let folders = [{ name: 'A', uri: URI.file('/workspace/A') }];
  let workspaceId = 'workspace';
  let profileId = 'profile';
  let configuration = URI.file('/workspace/original.code-workspace');
  const folderListeners = new Set();
  const nameListeners = new Set();
  const stateListeners = new Set();
  const profileListeners = new Set();
  const contentListeners = new Set();
  let text = initial;
  let version = 1;
  const model = {
    uri: URI.file('/workspace/A/file.ts'),
    getVersionId: () => version,
    getValue: () => text,
    getEOL: () => eol,
    getValueLength: () => text.length,
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: text.length + 1 }),
    onDidChangeContent: listener => {
      contentListeners.add(listener);
      return { dispose: () => contentListeners.delete(listener) };
    },
  };
  const launch = vi.fn(async (_edits, options) => {
    entered.resolve();
    await write.promise;
    if (!options.token?.isCancellationRequested && text !== replacement.replace(/\r\n|\r|\n/g, eol)) {
      text = replacement.replace(/\r\n|\r|\n/g, eol);
      version++;
      for (const listener of contentListeners) listener({ detailedReasons: sourceTagged ? [options.reason] : [] });
    }
    if (!options.token?.isCancellationRequested && _edits[0].edit.eol !== undefined) {
      const nextEol = _edits[0].edit.eol === 1 ? '\r\n' : '\n';
      if (eol !== nextEol) {
        eol = nextEol;
        text = text.replace(/\r\n|\r|\n/g, eol);
        version++;
        for (const listener of contentListeners) listener({ detailedReasons: [], isEolChange: true });
      }
    }
    written.resolve();
    await finish.promise;
    if (failAfterWrite) throw new Error('The model changed while Bulk Edit was preparing.');
    // Upstream reports isApplied for nonempty input, even if cancellation skipped the write.
    return { isApplied: true };
  });
  const adapter = new GlyphEditorAdapter(
    { createModelReference: async () => ({ object: { textEditorModel: model }, dispose() {} }) },
    { apply: launch },
    {
      getWorkspace: () => ({ id: workspaceId, configuration, folders }),
      isInsideWorkspace: () => folders.length > 0,
      onDidChangeWorkspaceFolders: listener => {
        folderListeners.add(listener);
        return { dispose: () => folderListeners.delete(listener) };
      },
      onDidChangeWorkspaceName: listener => {
        nameListeners.add(listener);
        return { dispose: () => nameListeners.delete(listener) };
      },
      onDidChangeWorkbenchState: listener => {
        stateListeners.add(listener);
        return { dispose: () => stateListeners.delete(listener) };
      },
    },
    { getModels: () => [model] },
    { isDirty: () => true },
    { isWorkspaceTrusted: () => true },
    {},
    { asCanonicalUri: resource => resource },
    {
      get currentProfile() {
        return { id: profileId };
      },
      onDidChangeCurrentProfile: listener => {
        profileListeners.add(listener);
        return { dispose: () => profileListeners.delete(listener) };
      },
    },
    {
      createInstance: (_constructor, _label, _code, _editor, group, _source, _progress, token, edits) => ({
        apply: async reason => {
          const result = await launch(edits, { token, reason, undoRedoGroupId: group.id });
          return result.isApplied ? [model.uri] : [];
        },
      }),
    },
  );
  const before = await adapter.read('file.ts');
  return {
    adapter,
    launch,
    before,
    entered,
    write,
    written,
    finish,
    text: () => text,
    changeWorkspace: change => {
      if (change.startsWith('profile')) {
        if (change !== 'profile metadata') profileId = 'replacement-profile';
        if (change !== 'profile pending notification') for (const listener of profileListeners) listener();
        return;
      }
      if (change === 'name' || change === 'state') workspaceId = 'replacement-workspace';
      if (change === 'configuration') configuration = URI.file('/workspace/replacement.code-workspace');
      const listeners = change === 'state' ? stateListeners : nameListeners;
      for (const listener of listeners) listener();
    },
    removeFolder: () => {
      folders = [];
      for (const listener of folderListeners) listener({});
    },
    apply: () =>
      adapter.handle({
        type: 'apply_text_mutation',
        mutation: {
          operationId: 'edit',
          path: 'file.ts',
          text: replacement,
          byteOrderMark: false,
          undoGroupId: 'edit',
          expectedContentRevision: before.contentRevision,
          expectedToken: before.token,
        },
      }),
  };
}

it.each(['trust revoked', 'destination occupied'])(
  'revalidates structural edits after native preparation: %s',
  async race => {
    const { GlyphEditorAdapter, URI } = await adapterModule();
    const root = { name: 'workspace', uri: URI.file('/workspace') };
    let trusted = true;
    let occupied = false;
    let written = false;
    const apply = vi.fn(async edits => {
      if (race === 'trust revoked') trusted = false;
      else occupied = true;
      await edits[0].validate();
      written = true;
      return { isApplied: true };
    });
    const adapter = new GlyphEditorAdapter(
      {},
      { apply },
      {
        getWorkspace: () => ({ id: 'workspace', folders: [root] }),
        isInsideWorkspace: () => true,
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
        onDidChangeWorkspaceName: () => ({ dispose() {} }),
        onDidChangeWorkbenchState: () => ({ dispose() {} }),
      },
      { getModel: () => null },
      { isDirty: () => false },
      { isWorkspaceTrusted: () => trusted },
      { exists: async () => occupied },
      { asCanonicalUri: uri => uri },
      { currentProfile: { id: 'profile' }, onDidChangeCurrentProfile: () => ({ dispose() {} }) },
    );
    try {
      const result = await adapter.handle({
        type: 'apply_file_mutation',
        mutation: {
          kind: 'create',
          path: 'file.ts',
          text: 'new',
          byteOrderMark: false,
          operationId: 'create',
          undoGroupId: 'create',
        },
      });
      expect(apply).toHaveBeenCalledOnce();
      expect(written).toBe(false);
      expect(result).toMatchObject({
        ok: false,
        error: { code: race === 'trust revoked' ? 'UNTRUSTED_WORKSPACE' : 'STALE_DOCUMENT' },
      });
      expect(await adapter.inspectReceipt('create')).toBeUndefined();
    } finally {
      adapter.dispose();
    }
  },
);
