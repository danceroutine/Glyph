import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {Parameters<import('oxlint/plugins-dev').RuleTester['run']>[1]} Rule */
/** @typedef {Parameters<NonNullable<Rule['create']>>[0]} Context */
/** @typedef {Parameters<Context['sourceCode']['getCommentsBefore']>[0]} Node */

const root = fileURLToPath(new URL('../../', import.meta.url));
const host = 'src/desktop/host/OpenAIDesktopRuntimeFactory.ts';
const cli = 'src/cli.ts';
const workbench = 'code-oss/overlay/src/vs/workbench/contrib/glyph/browser/';
const deterministicHost = 'src/desktop/host/DeterministicDesktopRuntime.ts';
const nativeShell = 'src/shell/NativeShellSandboxLauncher.ts';
const nativeIndex = 'src/context/search/RustWorkspacePathIndex.ts';
const nativeMetadata = 'src/workspace/NativeFilesystemMetadata.ts';
const disk = 'src/workspace/FileSystemWorkspaceTextStore.ts';
const policy = 'src/workspace/policy/WorkspaceAccessPolicy.ts';
const contentPolicy = 'src/workspace/policy/WorkspaceContentAccess.ts';
const rootPolicy = 'src/workspace/policy/WorkspaceRootAccess.ts';

// Exact importers only. Keep host state persistence separate from workspace I/O.
const filesystem = new Set([
  host,
  deterministicHost,
  'src/chat/sessions/SqliteChatSessionStore.ts',
  'src/editing/reviews/persistence/FileProposalReviewStore.ts',
  'src/interaction/approvals/FileApprovalStore.ts',
  'src/observability/FileLogger.ts',
  'src/providers/openai/auth/FileOpenAIAccountStore.ts',
  'src/reviewing/SqliteAgentReviewStore.ts',
  'src/shell/FileShellPermissionStore.ts',
  // OS adapters for project provenance, physical identity, or a single filesystem operation.
  disk,
  'src/workspace/ReservedWorkspaceDirectory.ts',
  nativeShell,
  'src/desktop/host/GlyphDesktopHost.ts',
  'src/desktop/host/WorkspaceOwnershipRegistry.ts',
  'src/desktop/workspace/createCatalogWorkspace.ts',
  'src/project/context/ProjectContextResolver.ts',
  'src/shell/ShellRuntimePathPolicy.ts',
  'src/shell/ShellWorkingDirectoryResolver.ts',
  'src/workspace/DirectoryNamePolicies.ts',
  'src/workspace/FilesystemMetadata.ts',
  'src/workspace/SourcePathAliases.ts',
  'src/workspace/UserStoreProjectRoutes.ts',
  'src/workspace/WorkspaceSourceRoutes.ts',
  'src/workspace/WorkspaceRootSelections.ts',
  'src/workspace/policy/StartupUserProfile.ts',
  'src/workspace/privateStorageMetadata.ts',
  'src/workspace/sameWorkspaceDirectory.ts',
  'src/workspace/withPrivateFileLock.ts',
  'src/workspace/workspaceCaseSensitivity.ts',
]);

const subprocess = new Set([
  nativeShell,
  nativeMetadata,
  nativeIndex,
  deterministicHost,
  'src/workspace/SourcePathAliases.ts',
  'src/workspace/readDirectoryNamePolicies.ts',
  // Opens the authentication URL in the user's browser.
  'src/terminal/TerminalUI.tsx',
]);

// Runtime access to concrete adapters belongs to composition. Feature code imports their ports.
const composition = new Set([cli, host]);
const shellComposition = new Set([...composition, deterministicHost]);
const policyConstruction = new Set([deterministicHost, contentPolicy, rootPolicy]);
const restrictedModules = new Map([
  ['fs', filesystem],
  ['fs/promises', filesystem],
  ['child_process', subprocess],
  ['worker_threads', subprocess],
  [disk, composition],
  ['src/workspace/WorkspaceRootSelections.ts', composition],
  [contentPolicy, composition],
  [rootPolicy, new Set([...composition, disk, nativeIndex])],
  ['src/workspace/PinnedSourceAuthority.ts', composition],
  [nativeMetadata, composition],
  [nativeIndex, composition],
  [nativeShell, shellComposition],
  ['src/workspace/policy/StartupUserProfile.ts', composition],
]);

// Workbench service modules also export ordinary enums and types. Restrict only service acquisition.
const symbols = new Map([
  [policy, { name: 'WorkspaceAccessPolicy', owners: new Set([...policyConstruction, disk, nativeShell, nativeIndex]) }],
  [
    '#vs/platform/files/common/files.js',
    {
      name: 'IFileService',
      owners: new Set(
        ['GlyphContextController', 'GlyphEditorAdapter', 'GlyphViewPane'].map(owner => workbench + owner + '.ts'),
      ),
    },
  ],
  [
    '#vs/workbench/services/textfile/common/textfiles.js',
    {
      name: 'ITextFileService',
      owners: new Set([workbench + 'GlyphEditorAdapter.ts']),
    },
  ],
  [
    '#vs/workbench/contrib/terminal/browser/terminal.js',
    {
      name: 'ITerminalService',
      owners: new Set(
        ['GlyphIdeContext', 'GlyphNativeContextActions', 'GlyphShellTerminals'].map(owner => workbench + owner + '.ts'),
      ),
    },
  ],
]);

/** @param {string} path */
function repoPath(path) {
  return relative(root, path).split(sep).join('/');
}

/** @param {string} importer @param {string} specifier */
function moduleKey(importer, specifier) {
  if (specifier.startsWith('node:')) return specifier.slice(5);
  if (specifier.startsWith('#src/')) return repoPath(resolve(root, specifier.slice(1))).replace(/\.js$/u, '.ts');
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const path = repoPath(resolve(dirname(importer), specifier));
    const overlay = 'code-oss/overlay/src/vs/';
    if (path.startsWith(overlay)) return '#vs/' + path.slice(overlay.length).replace(/\.ts$/u, '.js');
    return path.replace(/\.js$/u, '.ts');
  }
  return specifier;
}

/** @type {{ meta: {name: string}, rules: Record<string, Rule> }} */
export default {
  meta: { name: 'glyph-access' },
  rules: {
    'mediated-workspace-access': {
      meta: {
        type: 'problem',
        docs: { description: 'Use host-composed workspace and execution ports at feature boundaries.' },
        schema: [],
        messages: {
          mediated:
            'Access to {{capability}} belongs to its platform adapter. Use the injected operation described in docs/WORKSPACE_ACCESS.md.',
        },
      },
      create(context) {
        const importer = repoPath(context.filename);
        // Adapters may use the injected policy class for runtime validation.
        const policyBindings = new Set();
        const policyNamespaces = new Set();

        /**
         * A namespace, side-effect import, or export-all may expose every service in a module.
         * @param {Node} node @param {string} specifier @param {string[]=} names
         */
        function check(node, specifier, names) {
          const key = moduleKey(context.filename, specifier);
          const owners = restrictedModules.get(key);
          const service = symbols.get(key);
          if (owners && !owners.has(importer)) {
            context.report({ node, messageId: 'mediated', data: { capability: specifier } });
          } else if (service && (!names || names.includes(service.name)) && !service.owners.has(importer)) {
            context.report({ node, messageId: 'mediated', data: { capability: service.name } });
          }
        }

        return {
          ImportDeclaration(node) {
            if (node.importKind === 'type') return;
            const values = node.specifiers.filter(s => s.type !== 'ImportSpecifier' || s.importKind !== 'type');
            if (node.specifiers.length > 0 && values.length === 0) return;
            if (moduleKey(context.filename, node.source.value) === policy && !policyConstruction.has(importer)) {
              for (const specifier of values) {
                if (specifier.type === 'ImportNamespaceSpecifier') policyNamespaces.add(specifier.local.name);
                if (
                  specifier.type === 'ImportSpecifier' &&
                  specifier.imported.type === 'Identifier' &&
                  specifier.imported.name === 'WorkspaceAccessPolicy'
                )
                  policyBindings.add(specifier.local.name);
              }
            }
            const names = values.flatMap(s =>
              s.type === 'ImportSpecifier'
                ? [s.imported.type === 'Identifier' ? s.imported.name : s.imported.value]
                : [],
            );
            check(node, node.source.value, names.length > 0 && names.length === values.length ? names : undefined);
          },
          NewExpression(node) {
            const callee = node.callee;
            const local = callee.type === 'Identifier' && policyBindings.has(callee.name);
            const qualified =
              callee.type === 'MemberExpression' &&
              callee.object.type === 'Identifier' &&
              policyNamespaces.has(callee.object.name) &&
              (callee.computed
                ? callee.property.type === 'Literal' && callee.property.value === 'WorkspaceAccessPolicy'
                : callee.property.type === 'Identifier' && callee.property.name === 'WorkspaceAccessPolicy');
            if (local || qualified)
              context.report({ node, messageId: 'mediated', data: { capability: 'new WorkspaceAccessPolicy' } });
          },
          ExportNamedDeclaration(node) {
            if (!node.source || node.exportKind === 'type') return;
            const values = node.specifiers.filter(s => s.exportKind !== 'type');
            if (values.length > 0)
              check(
                node,
                node.source.value,
                values.map(s => (s.local.type === 'Identifier' ? s.local.name : s.local.value)),
              );
          },
          ExportAllDeclaration(node) {
            if (node.exportKind !== 'type') check(node, node.source.value);
          },
          ImportExpression(node) {
            if (node.source.type === 'Literal' && typeof node.source.value === 'string') check(node, node.source.value);
          },
          CallExpression(node) {
            const arg = node.arguments[0];
            if (
              node.callee.type === 'Identifier' &&
              node.callee.name === 'require' &&
              arg?.type === 'Literal' &&
              typeof arg.value === 'string'
            )
              check(node, arg.value);
          },
        };
      },
    },
  },
};
