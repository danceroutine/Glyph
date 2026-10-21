import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const sourceRoot = join(repositoryRoot, '.code-oss', 'src');
const overlayRoot = join(repositoryRoot, 'code-oss', 'overlay');
const upstream = path => join(sourceRoot, path);

const willRun =
  'await this._onWillRunWorkingCopyFileOperation.fireAsync(event, CancellationToken.None /* intentional: we currently only forward cancellation to participants */);';

function pristineCheckout() {
  return {
    [join(overlayRoot, 'src/vs/workbench/contrib/glyph/browser/Pane.ts')]:
      "import { URI } from '#vs/base/common/uri.js';\nexport const pane = URI;\n",
    [join(overlayRoot, 'src/vs/workbench/contrib/glyph/browser/notes.md')]: 'Overlay notes',
    [join(repositoryRoot, 'src/desktop/protocol/GlyphEvent.ts')]:
      "import { AgentMode } from '#src/chat/AgentMode.ts';\nexport const mode = AgentMode;\n",
    [join(repositoryRoot, 'src/desktop/protocol/nested/GlyphNested.ts')]: "export * from './Other.ts';\n",
    [join(repositoryRoot, 'src/desktop/protocol/tests/GlyphEvent.test.ts')]: 'ignored',
    [join(repositoryRoot, 'src/desktop/protocol/README.md')]: 'ignored',
    [join(repositoryRoot, 'src/desktop/workbench/GlyphState.ts')]: 'export const state = 1;\n',
    [join(repositoryRoot, 'src/chat/AgentMode.ts')]: "import { x } from './x.ts';\nexport const AgentMode = x;\n",
    [join(repositoryRoot, 'src/reviewing/AgentReview.ts')]: "export const review = 'AgentReview.ts';\n",
    [upstream('src/vs/workbench/workbench.desktop.main.ts')]:
      "import './contrib/terminal/electron-browser/terminal.contribution.js';\n",
    [upstream('src/vs/workbench/contrib/testing/browser/testResultsView/testResultsSubject.ts')]:
      'this.context = getMessageArgs(test, message);\n',
    [upstream('src/vs/workbench/contrib/testing/browser/testResultsView/testResultsViewContent.ts')]: [
      "import { FloatingClickMenu } from '../../../../../platform/actions/browser/floatingMenu.js';",
      'topFrame.height.set(provider.layout({ width, height: this.dimension?.height }, hasMultipleFrames)!, undefined);',
      'topFrame.height.set(provider.layout({ width, height: this.dimension.height }, hasMultipleFrames)!, undefined);',
      'this.currentTopFrame?.height.set(frameHeight, undefined);',
    ].join('\n'),
    [upstream('src/vs/workbench/browser/part.ts')]: [
      'protected layoutContents(width: number, height: number): ILayoutContentResult {',
      'return partLayout.layout(width, height);',
      'layout(width: number, height: number): ILayoutContentResult {',
      'if (this.options.hasTitle) {',
    ].join('\n'),
    [upstream('src/vs/workbench/browser/parts/paneCompositePart.ts')]: [
      'protected focusCompositeBar(): void {',
      'this.element.dataset.activeComposite = compositeId;',
    ].join('\n'),
    [upstream('src/vs/editor/browser/services/bulkEditService.ts')]:
      'export class ResourceFileEdit extends ResourceEdit implements IWorkspaceFileEdit {',
    [upstream('src/vs/workbench/services/workingCopy/common/workingCopyFileService.ts')]: [
      'export interface IFileOperationUndoRedoInfo {',
      willRun,
      willRun,
      willRun,
    ].join('\n'),
    [upstream('src/vs/workbench/contrib/bulkEdit/browser/bulkFileEdits.ts')]:
      'const undoRedoInfo = { undoRedoGroupId: this._undoRedoGroup.id };',
    [upstream('src/vs/code/electron-main/app.ts')]: [
      "import { ElectronAgentHostStarter } from '../../platform/agentHost/electron-main/electronAgentHostStarter.js';",
      '\t\tconst agentHostProcessManager = appInstantiationService.createInstance(AgentHostProcessManager, agentHostStarter, process.platform);',
    ].join('\n'),
    [upstream('product.json')]: JSON.stringify({ nameShort: 'Code - OSS', quality: 'oss' }),
  };
}

function directoryEntries(files, directory) {
  const names = new Map();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(`${directory}/`)) continue;
    const [name, ...rest] = path.slice(directory.length + 1).split('/');
    names.set(name, rest.length > 0 || names.get(name) === true);
  }
  return [...names].map(([name, isDirectory]) => ({ name, isDirectory: () => isDirectory }));
}

async function applyOverlay(files) {
  const operations = [];
  const filesystem = {
    readFile: vi.fn(async path => {
      if (!(path in files)) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
      return files[path];
    }),
    writeFile: vi.fn(async (path, contents) => {
      operations.push(['writeFile', path]);
      files[path] = contents;
    }),
    readdir: vi.fn(async directory => directoryEntries(files, directory)),
    rm: vi.fn(async (...arguments_) => operations.push(['rm', ...arguments_])),
    mkdir: vi.fn(async (...arguments_) => operations.push(['mkdir', ...arguments_])),
    cp: vi.fn(async (...arguments_) => operations.push(['cp', ...arguments_])),
  };
  const ui = { buildGlyphUi: vi.fn(async root => operations.push(['buildGlyphUi', root])) };
  onTestFinished(() => {
    vi.doUnmock('node:fs/promises');
    vi.doUnmock('#scripts/code-oss/build-ui.mjs');
  });
  vi.resetModules();
  vi.doMock('node:fs/promises', () => filesystem);
  vi.doMock('#scripts/code-oss/build-ui.mjs', () => ui);
  const result = import('#scripts/code-oss/apply-overlay.mjs');
  return { result, operations, files };
}

describe('apply-overlay', () => {
  it('regenerates Glyph-owned directories from the overlay, the UI bundle, and shared contracts', async () => {
    const run = await applyOverlay(pristineCheckout());
    await run.result;

    expect(run.operations.slice(0, 5)).toEqual([
      ['rm', upstream('src/vs/platform/glyph'), { recursive: true, force: true }],
      ['rm', upstream('src/vs/workbench/contrib/glyph'), { recursive: true, force: true }],
      ['cp', overlayRoot, sourceRoot, { recursive: true, force: true }],
      ['writeFile', upstream('src/vs/workbench/contrib/glyph/browser/Pane.ts')],
      ['buildGlyphUi', sourceRoot],
    ]);
    expect(run.files[upstream('src/vs/workbench/contrib/glyph/browser/Pane.ts')]).toBe(
      "import { URI } from '../../../../base/common/uri.js';\nexport const pane = URI;\n",
    );
    expect(run.files).not.toHaveProperty(upstream('src/vs/workbench/contrib/glyph/browser/notes.md'));
    expect(run.files[upstream('src/vs/platform/glyph/common/protocol/GlyphEvent.ts')]).toBe(
      'import { AgentMode } from "../../chat/AgentMode.js";\nexport const mode = AgentMode;\n',
    );
    expect(run.files[upstream('src/vs/platform/glyph/common/protocol/nested/GlyphNested.ts')]).toBe(
      "export * from './Other.js';\n",
    );
    expect(run.files).not.toHaveProperty(upstream('src/vs/platform/glyph/common/protocol/tests/GlyphEvent.test.ts'));
    expect(run.files).not.toHaveProperty(upstream('src/vs/platform/glyph/common/protocol/README.md'));
    expect(run.files[upstream('src/vs/platform/glyph/common/workbench/GlyphState.ts')]).toBe(
      'export const state = 1;\n',
    );
    expect(run.files[upstream('src/vs/platform/glyph/chat/AgentMode.ts')]).toBe(
      "import { x } from './x.js';\nexport const AgentMode = x;\n",
    );
    expect(run.files[upstream('src/vs/platform/glyph/reviewing/AgentReview.ts')]).toBe(
      "export const review = 'AgentReview.ts';\n",
    );
    expect(run.operations.filter(([kind]) => kind === 'mkdir').map(([, path]) => path)).toEqual([
      upstream('src/vs/platform/glyph/common/protocol'),
      upstream('src/vs/platform/glyph/common/protocol/nested'),
      upstream('src/vs/platform/glyph/chat'),
      upstream('src/vs/platform/glyph/reviewing'),
      upstream('src/vs/platform/glyph/common/workbench'),
    ]);
  });

  it('patches every pinned upstream anchor in a pristine checkout', async () => {
    const run = await applyOverlay(pristineCheckout());
    await run.result;

    expect(run.files[upstream('src/vs/workbench/workbench.desktop.main.ts')]).toBe(
      "import './contrib/terminal/electron-browser/terminal.contribution.js';\nimport './contrib/glyph/electron-browser/glyph.contribution.js';\n",
    );
    expect(run.files[upstream('src/vs/workbench/contrib/testing/browser/testResultsView/testResultsSubject.ts')]).toBe(
      'this.context = Object.assign(getMessageArgs(test, message), { glyphResultId: result.id, glyphTaskIndex: taskIndex, glyphMessageIndex: messageIndex });\n',
    );
    expect(
      run.files[upstream('src/vs/workbench/contrib/testing/browser/testResultsView/testResultsViewContent.ts')],
    ).toBe(
      [
        "import { GlyphTestFailureMenu as FloatingClickMenu } from '../../../glyph/browser/GlyphTestFailureMenu.js';",
        'topFrame.height.set(Math.max(64, provider.layout({ width, height: this.dimension?.height }, hasMultipleFrames)!), undefined);',
        'topFrame.height.set(Math.max(64, provider.layout({ width, height: this.dimension.height }, hasMultipleFrames)!), undefined);',
        'this.currentTopFrame?.height.set(Math.max(64, frameHeight), undefined);',
      ].join('\n'),
    );
    expect(run.files[upstream('src/vs/workbench/browser/part.ts')]).toBe(
      [
        'protected isTitleVisible(): boolean { return !!this.options.hasTitle; }',
        '',
        '\tprotected layoutContents(width: number, height: number): ILayoutContentResult {',
        'const titleVisible = this.isTitleVisible();',
        "\t\tif (this.titleArea) this.titleArea.style.display = titleVisible ? '' : 'none';",
        '\t\treturn partLayout.layout(width, height, titleVisible);',
        'layout(width: number, height: number, titleVisible = !!this.options.hasTitle): ILayoutContentResult {',
        'if (titleVisible) {',
      ].join('\n'),
    );
    expect(run.files[upstream('src/vs/workbench/browser/parts/paneCompositePart.ts')]).toBe(
      [
        'protected override isTitleVisible(): boolean {',
        "\t\treturn super.isTitleVisible() && !(this.partId === Parts.AUXILIARYBAR_PART && this.getActivePaneComposite()?.getId() === 'workbench.view.glyphContainer' && this.getVisiblePaneCompositeIds().length <= 1);",
        '\t}',
        '',
        '\tprotected focusCompositeBar(): void {',
        'this.element.dataset.activeComposite = compositeId;',
        '\t\tconst dimension = this.getRelayoutDimension();',
        '\t\tif (dimension && this.contentPosition) this.layout(dimension.width, dimension.height, this.contentPosition.top, this.contentPosition.left);',
      ].join('\n'),
    );
    expect(run.files[upstream('src/vs/editor/browser/services/bulkEditService.ts')]).toBe(
      'export class ResourceFileEdit extends ResourceEdit implements IWorkspaceFileEdit {\n\tvalidate?: () => Promise<void>;',
    );
    expect(run.files[upstream('src/vs/workbench/contrib/bulkEdit/browser/bulkFileEdits.ts')]).toBe(
      'const undoRedoInfo = { undoRedoGroupId: this._undoRedoGroup.id, validate: async () => { for (const edit of this._edits) await edit.validate?.(); } };',
    );
    const guarded = `${willRun}\n\t\ttry { await undoInfo?.validate?.(); } catch (error) {\n\t\t\tawait this._onDidFailWorkingCopyFileOperation.fireAsync(event, CancellationToken.None);\n\t\t\tthrow error;\n\t\t}`;
    expect(run.files[upstream('src/vs/workbench/services/workingCopy/common/workingCopyFileService.ts')]).toBe(
      [
        'export interface IFileOperationUndoRedoInfo {\n\tvalidate?: () => Promise<void>;',
        guarded,
        guarded,
        guarded,
      ].join('\n'),
    );
    expect(run.files[upstream('src/vs/code/electron-main/app.ts')]).toBe(
      [
        "import { ElectronAgentHostStarter } from '../../platform/agentHost/electron-main/electronAgentHostStarter.js';",
        "import { GlyphHostStarter } from '../../platform/glyph/electron-main/glyphHostStarter.js';",
        '\t\tconst agentHostProcessManager = appInstantiationService.createInstance(AgentHostProcessManager, agentHostStarter, process.platform);',
        '\t\tthis._register(appInstantiationService.createInstance(GlyphHostStarter));',
      ].join('\n'),
    );
  });

  it('brands the product and points its gallery at Open VSX', async () => {
    const run = await applyOverlay(pristineCheckout());
    await run.result;

    const product = run.files[upstream('product.json')];
    expect(product.endsWith('}\n')).toBe(true);
    expect(product).toContain('\t"nameShort": "Glyph"');
    expect(JSON.parse(product)).toEqual({
      nameShort: 'Glyph',
      quality: 'oss',
      nameLong: 'Glyph',
      applicationName: 'glyph',
      dataFolderName: '.glyph-editor',
      urlProtocol: 'glyph',
      darwinBundleIdentifier: 'com.danceroutine.glyph',
      win32AppUserModelId: 'Danceroutine.Glyph',
      win32MutexName: 'glyph',
      win32RegValueName: 'Glyph',
      linuxIconName: 'glyph',
      serverApplicationName: 'glyph-server',
      extensionsGallery: {
        serviceUrl: 'https://open-vsx.org/vscode/gallery',
        itemUrl: 'https://open-vsx.org/vscode/item',
        resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
        extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
      },
      linkProtectionTrustedDomains: ['https://open-vsx.org'],
    });
  });

  it('leaves an already patched checkout unchanged', async () => {
    const first = await applyOverlay(pristineCheckout());
    await first.result;
    const patched = { ...first.files };

    const second = await applyOverlay({ ...patched });
    await second.result;

    expect(second.files).toEqual(patched);
    const anchored = [
      'src/vs/workbench/workbench.desktop.main.ts',
      'src/vs/workbench/contrib/testing/browser/testResultsView/testResultsSubject.ts',
      'src/vs/workbench/browser/part.ts',
      'src/vs/workbench/browser/parts/paneCompositePart.ts',
      'src/vs/editor/browser/services/bulkEditService.ts',
      'src/vs/workbench/services/workingCopy/common/workingCopyFileService.ts',
      'src/vs/workbench/contrib/bulkEdit/browser/bulkFileEdits.ts',
      'src/vs/code/electron-main/app.ts',
    ].map(upstream);
    expect(second.operations.filter(([kind, path]) => kind === 'writeFile' && anchored.includes(path))).toEqual([]);
  });

  it.each([
    [
      'src/vs/workbench/workbench.desktop.main.ts',
      /^Pinned Code OSS anchor was not found in .*workbench\.desktop\.main\.ts$/,
    ],
    [
      'src/vs/workbench/contrib/testing/browser/testResultsView/testResultsSubject.ts',
      /^Pinned test-message context anchor was not found\.$/,
    ],
    [
      'src/vs/workbench/contrib/testing/browser/testResultsView/testResultsViewContent.ts',
      /^Pinned test-message view anchor was not found\.$/,
    ],
    [
      'src/vs/workbench/browser/part.ts',
      /^Pinned chat-header layout anchor was not found: src\/vs\/workbench\/browser\/part\.ts$/,
    ],
    [
      'src/vs/editor/browser/services/bulkEditService.ts',
      /^Pinned structural mutation anchor missing: src\/vs\/editor\/browser\/services\/bulkEditService\.ts$/,
    ],
  ])('fails closed when %s no longer contains its anchor', async (path, message) => {
    const run = await applyOverlay({ ...pristineCheckout(), [upstream(path)]: 'unrecognized upstream source' });

    await expect(run.result).rejects.toThrow(message);
  });

  it('fails closed when the working-copy service no longer has three mutation boundaries', async () => {
    const files = pristineCheckout();
    files[upstream('src/vs/workbench/services/workingCopy/common/workingCopyFileService.ts')] =
      `export interface IFileOperationUndoRedoInfo {\n${willRun}`;

    const run = await applyOverlay(files);

    await expect(run.result).rejects.toThrow('Expected three pinned working-copy mutation boundaries.');
  });
});
