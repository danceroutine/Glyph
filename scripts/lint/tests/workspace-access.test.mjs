import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const name = 'glyph-access/mediated-workspace-access';

/** @type {[string, string, boolean][]} */
const cases = [
  ['src/skills/LocalIntake.ts', "import { readHostFile } from './readHostFile.ts';", true],
  ['src/skills/LocalSkillSourceAuthority.ts', "import { open } from 'node:fs/promises';", false],
  ['src/skills/AdHocIntake.ts', "import * as intake from './LocalSkillSourceAuthority.ts';", true],
  ['src/skills/Outside.ts', 'const read = skill.inspectResource;', true],
  ['src/skills/Other.ts', "selected['packageFiles']();", true],
  ['src/skills/DirectoryViewer.ts', "const directories = selected['packageDirectories'];", true],
  ['src/skills/SkillPackageDraft.ts', 'const directories = selected.packageDirectories();', false],
  ['src/skills/SkillScriptRunner.ts', 'selected.packageFiles();', false],
  ['src/skills/Feature.ts', "import { captureSkillPackage } from './SkillPackage.ts';", true],
  ['src/skills/Presenter.ts', "import type { SkillPackage } from './SkillPackage.ts';", false],
  [
    'src/skills/FileSkillDiscoveryProvider.ts',
    "import { lstat } from 'node:fs/promises'; import { captureSkillPackage } from './SkillPackage.ts';",
    false,
  ],
  [
    'src/desktop/host/GlyphDesktopHost.ts',
    "import { WindowCommandAuthority } from './WindowCommandAuthority.ts';",
    false,
  ],
  [
    'src/desktop/host/ProviderDesktopRuntime.ts',
    "import { WindowCommandAuthority } from './WindowCommandAuthority.ts';",
    true,
  ],
  ['src/cli.ts', "import { WorkspaceAccessPolicy } from './workspace/policy/WorkspaceAccessPolicy.js';", true],
  [
    'code-oss/overlay/src/vs/workbench/contrib/glyph/browser/Feature.ts',
    "import { IFileService } from '../../../../platform/files/common/files.js';",
    true,
  ],
  ['src/chat/Raw.ts', "import { readFile as load } from 'node:fs/promises';", true],
  ['src/chat/Launch.ts', "export * from 'child_process';", true],
  ['src/chat/Lazy.ts', "const adapter = await import('#src/workspace/FileSystemWorkspaceTextStore.js');", true],
  ['src/chat/Legacy.ts', "require('node:worker_threads');", true],
  [
    'src/chat/Forward.ts',
    "export { NativeFilesystemMetadata as Metadata } from '../workspace/NativeFilesystemMetadata.ts';",
    true,
  ],
  ['src/chat/Typed.ts', "import { type FileHandle } from 'node:fs/promises';", false],
  [
    'src/workspace/FileSystemWorkspaceTextStore.ts',
    "import { WorkspaceAccessPolicy as Policy } from './policy/WorkspaceAccessPolicy.ts'; new Policy();",
    true,
  ],
  [
    'src/context/search/RustWorkspacePathIndex.ts',
    "import * as p from '#src/workspace/policy/WorkspaceAccessPolicy.js'; new p.WorkspaceAccessPolicy();",
    true,
  ],
  ['src/chat/Port.ts', "import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';", false],
  ['src/shell/FileShellPermissionStore.ts', "import * as fs from 'node:fs/promises';", false],
  ['src/chat/FileSystemWorkspaceTextStore.ts', "import * as fs from 'node:fs/promises';", true],
  ['src/chat/tests/raw.test.ts', "import { open } from 'node:fs/promises';", false],
  ['code-oss/ui/src/Rogue.tsx', "import { IFileService as files } from '#vs/platform/files/common/files.js';", true],
  ['code-oss/ui/src/Enum.tsx', "import { FileChangeType } from '#vs/platform/files/common/files.js';", false],
  [
    'code-oss/ui/src/FileChanges.ts',
    "import { type IFileService, FileChangeType } from '#vs/platform/files/common/files.js';",
    false,
  ],
  [
    'code-oss/ui/src/FileServices.ts',
    "export { type FileChangeType, IFileService as fileService } from '#vs/platform/files/common/files.js';",
    true,
  ],
  ['src/chat/Nothing.ts', "import type { FileHandle } from 'fs/promises'; export type { FileHandle };", false],
  [
    'src/chat/ForwardType.ts',
    "export type * from 'node:fs'; export { type FileHandle } from 'node:fs/promises';",
    false,
  ],
  ['src/chat/ForwardAlias.ts', "export { IFileService as reader } from '#vs/platform/files/common/files.js';", true],
  ['src/chat/TypeForward.ts', "export type { FileHandle } from 'node:fs/promises';", false],
  ['src/chat/Local.ts', 'const data = 1; export { data };', false],
  [
    'src/chat/Expr.ts',
    'new Map(); new globalThis.Set(); import(variable); require(variable); object.require();',
    false,
  ],
  ['src/chat/Reserved.ts', "import 'fs';", true],
  ['src/chat/Package.ts', "import something from 'zod';", false],
  ['src/chat/Namespace.ts', "import * as files from '#vs/platform/files/common/files.js';", true],
  ['src/chat/NamedString.ts', "import { 'IFileService' as reader } from '#vs/platform/files/common/files.js';", true],
  ['src/chat/ForwardString.ts', "export { 'IFileService' as reader } from '#vs/platform/files/common/files.js';", true],
  [
    'src/chat/Unrelated.ts',
    "import { skillExecutionDirectory } from '#src/workspace/policy/WorkspaceAccessPolicy.js';",
    false,
  ],
  [
    'src/workspace/policy/WorkspaceContentAccess.ts',
    "import { WorkspaceAccessPolicy } from './WorkspaceAccessPolicy.js'; new WorkspaceAccessPolicy();",
    false,
  ],
  [
    'src/shell/NativeShellSandboxLauncher.ts',
    "import * as api from '#src/workspace/policy/WorkspaceAccessPolicy.js'; new api['WorkspaceAccessPolicy']();",
    true,
  ],
  [
    'code-oss/overlay/src/vs/workbench/contrib/glyph/browser/GlyphEditorAdapter.ts',
    "import { IFileService } from '#vs/platform/files/common/files.js';",
    false,
  ],
];

describe('workspace access at a module boundary', () => {
  const fixtures = cases.filter(([file]) => !file.includes('/tests/'));
  /** @type {Map<string, string | null>} */
  let outcomes;
  beforeAll(() => {
    const result = spawnSync(process.execPath, ['scripts/lint/tests/fixtures/check-workspace-rule.mjs'], {
      cwd: root,
      input: JSON.stringify(fixtures),
      encoding: 'utf8',
      timeout: 20000,
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr + result.stdout).toBe(0);
    outcomes = new Map(JSON.parse(result.stdout));
  });
  it.each(fixtures)('%s', file => {
    expect(outcomes.get(file)).toBeNull();
  });
});

it('enforces the production ownership map through Oxlint using the repository overrides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'glyph-lint-access-'));

  try {
    const plugin = 'scripts/lint/workspace-access.mjs';
    mkdirSync(join(directory, dirname(plugin)), { recursive: true });
    copyFileSync(join(root, plugin), join(directory, plugin));
    /** @type {{ overrides: { files: string[], rules?: Record<string, string> }[] }} */
    const source = JSON.parse(readFileSync(join(root, '.oxlintrc.json'), 'utf8'));
    const config = {
      jsPlugins: ['./' + plugin],
      categories: { correctness: 'off' },
      overrides: source.overrides.flatMap(({ files, rules }) =>
        rules?.[name] ? [{ files, rules: { [name]: rules[name] } }] : [],
      ),
    };
    writeFileSync(join(directory, '.oxlintrc.json'), JSON.stringify(config));
    for (const [file, body] of cases) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), body);
    }
    const result = spawnSync(
      process.execPath,
      [join(root, 'node_modules/oxlint/bin/oxlint'), '--format', 'json', '.'],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    if (result.error) throw result.error;
    expect(result.status, result.stderr + result.stdout).toBe(1);
    /** @type {{ diagnostics: { filename: string }[] }} */
    const output = JSON.parse(result.stdout);
    const reported = output.diagnostics.map(diagnostic => diagnostic.filename).toSorted();
    expect(reported).toEqual(
      cases
        .filter(([, , denied]) => denied)
        .map(([file]) => file)
        .toSorted(),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
