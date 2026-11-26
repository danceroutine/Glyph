import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { NativeWorkspaceMutations } from '#src/workspace/NativeWorkspaceMutations.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-mutation-wire-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const helper = join(root, 'helper.mjs');
  const request = join(root, 'request');
  const reply = join(root, 'reply');
  await writeFile(
    helper,
    [
      '#!' + process.execPath,
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const input = readFileSync(0, 'utf8');",
      'writeFileSync(' + JSON.stringify(request) + ', input);',
      'process.stdout.write(readFileSync(' + JSON.stringify(reply) + '));',
    ].join('\n'),
    { mode: 0o700 },
  );
  return { root, helper, reply, request, mutations: await NativeWorkspaceMutations.open(helper, root) };
}
it('sends the same pinned root identity and relative paths for every native operation', async () => {
  const { root, mutations, reply, request } = await fixture();
  const identity = await lstat(root, { bigint: true });
  const context = { root, rootIdentity: { device: String(identity.dev), inode: String(identity.ino) } };
  await writeFile(reply, '{"ok":true}\n');
  await mutations.ensureDirectory('a/b');
  expect(JSON.parse(await readFile(request, 'utf8'))).toEqual({
    ...context,
    operation: 'ensure_directory',
    relative: 'a/b',
  });
  await mutations.ensureDirectory('a/b', 0o755);
  expect(JSON.parse(await readFile(request, 'utf8'))).toMatchObject({ mode: 0o755 });
  await mutations.createStage('.skill-staging/id');
  expect(JSON.parse(await readFile(request, 'utf8'))).toMatchObject({ operation: 'create_stage' });
  await mutations.stagePackage(
    '.skill-staging/id/package',
    new Map([['SKILL.md', { bytes: Uint8Array.of(97), mode: 0o644 }]]),
    new Map([['', 0o755]]),
  );
  expect(JSON.parse(await readFile(request, 'utf8'))).toMatchObject({
    operation: 'stage_package',
    files: [{ path: 'SKILL.md', mode: 0o644, content: 'YQ==' }],
    directories: [{ path: '', mode: 0o755 }],
  });
  await mutations.renameExclusive('a/b', 'c');
  expect(JSON.parse(await readFile(request, 'utf8'))).toEqual({
    ...context,
    operation: 'rename_exclusive',
    sourceRelative: 'a/b',
    targetRelative: 'c',
  });
  await mutations.removeTree('c');
  expect(JSON.parse(await readFile(request, 'utf8'))).toEqual({ ...context, operation: 'remove_tree', relative: 'c' });
});
it('propagates native failures and rejects unacknowledged, oversized or malformed operations', async () => {
  const { root, helper, mutations, reply } = await fixture();
  await writeFile(reply, JSON.stringify({ ok: false, code: 'EEXIST', message: 'Occupied destination.' }));
  await expect(mutations.renameExclusive('a', 'b')).rejects.toMatchObject({
    code: 'EEXIST',
    message: 'Occupied destination.',
  });
  for (const invalid of ['{', '{"success":true}', 'a'.repeat(17 * 1024)]) {
    await writeFile(reply, invalid);
    await expect(mutations.removeTree('a')).rejects.toThrow();
  }
  await expect(mutations.ensureDirectory('d'.repeat(32 * 1024))).rejects.toThrow('32 KiB');
  await expect(
    mutations.stagePackage(
      '.skill-staging/id/package',
      new Map([['oversize', { bytes: Buffer.alloc(18 * 1024 * 1024), mode: 0o600 }]]),
      new Map([['', 0o700]]),
    ),
  ).rejects.toThrow('24576 KiB');
  await rm(helper);
  await expect(mutations.ensureDirectory('a')).rejects.toThrow();
  const alias = join(root, 'alias');
  await symlink(root, alias);
  await expect(NativeWorkspaceMutations.open(helper, alias)).rejects.toThrow('physical root');
  await expect(NativeWorkspaceMutations.open(helper, reply)).rejects.toThrow();
});
