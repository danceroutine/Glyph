/**
 * @fileoverview Recreates Glyph's intentionally small Code OSS patch on top of
 * the pinned generated source tree. Keeping this operation idempotent lets us
 * review Glyph-owned files separately from upstream and regenerate at will.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGlyphUi } from './build-ui.mjs';
import { resolveOverlayImports } from './resolve-overlay-imports.mjs';
import { sourceAliasTransformer } from '#scripts/imports/source-alias-transformer.mjs';
import ts from 'typescript';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceRoot = join(repositoryRoot, '.code-oss', 'src');
const overlayRoot = join(repositoryRoot, 'code-oss', 'overlay');

// These two directories are generated exclusively from Glyph-owned sources.
// Recreate them so removed modules and case-only renames cannot linger locally.
await rm(join(sourceRoot, 'src', 'vs', 'platform', 'glyph'), { recursive: true, force: true });
await rm(join(sourceRoot, 'src', 'vs', 'workbench', 'contrib', 'glyph'), { recursive: true, force: true });
await cp(overlayRoot, sourceRoot, { recursive: true, force: true });
await resolveOverlayTree(overlayRoot, sourceRoot);
await buildGlyphUi(sourceRoot);
const protocolSourceRoot = join(repositoryRoot, 'src', 'desktop', 'protocol');
const protocolTargetRoot = join(sourceRoot, 'src', 'vs', 'platform', 'glyph', 'common', 'protocol');
await copyProtocol(protocolSourceRoot, protocolTargetRoot);
// Protocol modes share the runtime enum. Preserve its relative source location
// in the generated tree instead of maintaining a second set of wire values.
const chatContractTarget = join(sourceRoot, 'src', 'vs', 'platform', 'glyph', 'chat');
await mkdir(chatContractTarget, { recursive: true });
for (const name of ['AgentMode.ts']) {
  const source = join(repositoryRoot, 'src', 'chat', name);
  await writeFile(join(chatContractTarget, name), (await readFile(source, 'utf8')).replaceAll(".ts'", ".js'"));
}
await copyProtocol(
  join(repositoryRoot, 'src', 'desktop', 'workbench'),
  join(sourceRoot, 'src', 'vs', 'platform', 'glyph', 'common', 'workbench'),
);

async function copyProtocol(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== 'tests') await copyProtocol(join(source, entry.name), join(target, entry.name));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const contents = await readFile(join(source, entry.name), 'utf8');
    const input = ts.createSourceFile(join(source, entry.name), contents, ts.ScriptTarget.Latest, true);
    const transformed = ts.transform(input, [sourceAliasTransformer]);
    try {
      const emitted = ts.createPrinter().printFile(transformed.transformed[0]);
      await writeFile(join(target, entry.name), emitted.replaceAll(".ts'", ".js'"));
    } finally {
      transformed.dispose();
    }
  }
}

async function resolveOverlayTree(source, target) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const input = join(source, entry.name);
    const output = join(target, entry.name);
    if (entry.isDirectory()) {
      await resolveOverlayTree(input, output);
    } else if (entry.name.endsWith('.ts')) {
      await writeFile(output, resolveOverlayImports(await readFile(input, 'utf8'), input));
    }
  }
}

const workbenchEntry = join(sourceRoot, 'src', 'vs', 'workbench', 'workbench.desktop.main.ts');
await insertOnce(
  workbenchEntry,
  "import './contrib/glyph/electron-browser/glyph.contribution.js';",
  "import './contrib/terminal/electron-browser/terminal.contribution.js';",
);

// Native test-message menus otherwise serialize only the test and message, losing run identity.
const testSubjectPath = join(
  sourceRoot,
  'src/vs/workbench/contrib/testing/browser/testResultsView/testResultsSubject.ts',
);
const testSubject = await readFile(testSubjectPath, 'utf8');
const testAnchor = 'this.context = getMessageArgs(test, message);';
const testReplacement =
  'this.context = Object.assign(getMessageArgs(test, message), { glyphResultId: result.id, glyphTaskIndex: taskIndex, glyphMessageIndex: messageIndex });';
if (!testSubject.includes(testReplacement)) {
  if (!testSubject.includes(testAnchor)) throw new Error('Pinned test-message context anchor was not found.');
  await writeFile(testSubjectPath, testSubject.replace(testAnchor, testReplacement));
}

// The native test message menu keeps its command plumbing; only Glyph's action
// uses the shared button. Reserve enough height for an action beside a one-line failure.
const testContentPath = join(
  sourceRoot,
  'src/vs/workbench/contrib/testing/browser/testResultsView/testResultsViewContent.ts',
);
let testContent = await readFile(testContentPath, 'utf8');
for (const [before, after] of [
  [
    "import { FloatingClickMenu } from '../../../../../platform/actions/browser/floatingMenu.js';",
    "import { GlyphTestFailureMenu as FloatingClickMenu } from '../../../glyph/browser/GlyphTestFailureMenu.js';",
  ],
  [
    'topFrame.height.set(provider.layout({ width, height: this.dimension?.height }, hasMultipleFrames)!, undefined);',
    'topFrame.height.set(Math.max(64, provider.layout({ width, height: this.dimension?.height }, hasMultipleFrames)!), undefined);',
  ],
  [
    'topFrame.height.set(provider.layout({ width, height: this.dimension.height }, hasMultipleFrames)!, undefined);',
    'topFrame.height.set(Math.max(64, provider.layout({ width, height: this.dimension.height }, hasMultipleFrames)!), undefined);',
  ],
  [
    'this.currentTopFrame?.height.set(frameHeight, undefined);',
    'this.currentTopFrame?.height.set(Math.max(64, frameHeight), undefined);',
  ],
]) {
  if (testContent.includes(after)) continue;
  if (!testContent.includes(before)) throw new Error('Pinned test-message view anchor was not found.');
  testContent = testContent.replace(before, after);
}
await writeFile(testContentPath, testContent);

const applicationEntry = join(sourceRoot, 'src', 'vs', 'code', 'electron-main', 'app.ts');
await insertOnce(
  applicationEntry,
  "import { GlyphHostStarter } from '../../platform/glyph/electron-main/glyphHostStarter.js';",
  "import { ElectronAgentHostStarter } from '../../platform/agentHost/electron-main/electronAgentHostStarter.js';",
);
await insertOnce(
  applicationEntry,
  '\t\tthis._register(appInstantiationService.createInstance(GlyphHostStarter));',
  '\t\tconst agentHostProcessManager = appInstantiationService.createInstance(AgentHostProcessManager, agentHostStarter, process.platform);',
);

const productPath = join(sourceRoot, 'product.json');
const product = JSON.parse(await readFile(productPath, 'utf8'));
Object.assign(product, {
  nameShort: 'Glyph',
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
await writeFile(productPath, `${JSON.stringify(product, null, '\t')}\n`);

async function insertOnce(path, insertion, anchor) {
  // Anchors deliberately fail closed when the pinned upstream layout changes;
  // silently inserting near the wrong code would be harder to review and debug.
  const source = await readFile(path, 'utf8');
  if (source.includes(insertion)) return;
  if (!source.includes(anchor)) throw new Error(`Pinned Code OSS anchor was not found in ${path}`);
  await writeFile(path, source.replace(anchor, `${anchor}\n${insertion}`));
}
