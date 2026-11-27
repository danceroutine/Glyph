import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const name = 'glyph-access/mediated-workspace-access';

it('enforces the production ownership map through Oxlint using the repository overrides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'glyph-lint-access-'));
  /** @type {[string, string, boolean][]} */
  const cases = [
    ['src/chat/Raw.ts', "import { readFile as load } from 'node:fs/promises';", true],
    ['src/chat/Launch.ts', "export * from 'child_process';", true],
    ['src/chat/Lazy.ts', "const adapter = await import('#src/workspace/FileSystemWorkspaceTextStore.js');", true],
    ['src/skills/Feature.ts', "import { captureSkillPackage } from './SkillPackage.ts';", true],
    ['src/skills/Presenter.ts', "import type { SkillPackage } from './SkillPackage.ts';", false],
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
  ];

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
