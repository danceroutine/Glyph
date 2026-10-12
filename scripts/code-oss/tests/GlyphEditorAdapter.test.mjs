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
            if (args.path.startsWith('#vs/base/'))
              return { path: resolve('.code-oss/src/src/vs', args.path.slice(4).replace(/\.js$/, '.ts')) };
            return { path: args.path, namespace: 'services' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'services' }, () => ({
            loader: 'js',
            contents: `
        const service = () => {};
        export { service as IModelService, service as ITextFileService, service as IFileService,
          service as IWorkspaceTrustManagementService, service as IBulkEditService,
          service as ITextModelService, service as IWorkspaceContextService };
        export const FileOperationResult = { FILE_NOT_FOUND: 1 };
        export const toFileOperationResult = () => -1;
        export class ResourceTextEdit { constructor(resource, edit, version) { Object.assign(this, { resource, edit, version }); } }
        export class UndoRedoGroup { id = 1; }
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
  it('[round3-03] refuses old host paths after folder removal instead of reading or editing a nested namesake', async () => {
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
