import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';

it('passes an open descriptor and requires the native inspection acknowledgement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glyph-inspector-'));
  const file = join(root, 'file');
  await writeFile(file, 'fixture bytes');
  const handle = await open(file);
  onTestFinished(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });
  const script = join(root, 'inspector');
  const backend = new NativeFilesystemMetadata(script);
  await expect(backend.inspect(handle, 'access')).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(script, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await expect(backend.inspect(handle, 'access')).rejects.toThrow('metadata');
  await writeFile(script, '#!/bin/sh\nexit 0\n');
  await expect(backend.inspect(handle, 'access')).rejects.toThrow('metadata');
  await writeFile(
    script,
    '#!/bin/sh\n[ "$1" = "--assert-replaceable-metadata" ] && [ "$(/bin/cat)" = "fixture bytes" ] && echo verified\n',
  );
  await backend.inspect(handle, 'replaceable');
});

it('requires the native host path check to acknowledge the requested paths and every workspace root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glyph-host-authority-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'inspector');
  const authority = new NativeFilesystemMetadata(executable);
  const check = () => authority.assertHostPaths(['/host/file'], ['/project']);
  await expect(check()).rejects.toThrow();
  await writeFile(executable, '#!/bin/sh\n/bin/cat >/dev/null\nexit 1\n', { mode: 0o700 });
  await expect(check()).rejects.toThrow('host filesystem authority');
  await writeFile(
    executable,
    `#!/bin/sh
[ "$1" = "--assert-host-paths" ] && [ "$(/bin/cat)" = '{"paths":["/host/file"],"workspaceRoots":["/project"]}' ] && echo verified
`,
  );
  await check();
});

it('passes physical exclusions and the opened identity to native path admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glyph-path-admission-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'document');
  const script = join(root, 'inspector');
  const receipt = join(root, 'request');
  await writeFile(file, 'example');
  await writeFile(script, '#!/bin/sh\n/bin/cat > "' + receipt + '"\necho verified\n', { mode: 0o700 });
  const native = new NativeFilesystemMetadata(script);
  const handle = await open(file);
  try {
    const stat = await handle.stat({ bigint: true });
    await native.assertWorkspacePath(file, [root + '/private'], { handle, managedDirectories: [root + '/skills'] });
    expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({
      path: file,
      privatePaths: [root + '/private'],
      managedDirectories: [root + '/skills'],
      identity: [String(stat.dev), String(stat.ino)],
    });
    await native.assertWorkspacePath(file, []);
    expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({ path: file, privatePaths: [] });
    await writeFile(script, '#!/bin/sh\n/bin/cat >/dev/null\necho refused\n');
    await expect(native.assertWorkspacePath(file, [])).rejects.toThrow('excluded');
    await writeFile(script, '#!/bin/sh\n/bin/cat >/dev/null\nexit 1\n');
    await expect(native.assertWorkspacePath(file, [])).rejects.toThrow('excluded');
  } finally {
    await handle.close();
  }
});

it('inspects selected directory routes and distinguishes a removed selection from a live directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'glyph-directory-origin-'));
  const backend = new NativeFilesystemMetadata(join(process.cwd(), 'target/release/glyph-context-index'));
  const handle = await open(directory);
  onTestFinished(async () => {
    await handle.close();
    await rm(directory, { force: true, recursive: true });
  });
  const metadata = await handle.stat({ bigint: true });
  expect(await backend.sourceOrigins([directory], [], undefined, true)).toEqual([
    { identity: `${metadata.dev}:${metadata.ino}`, origin: expect.stringMatching(/^[a-f0-9]{64}$/u) },
  ]);
  await expect(backend.assertUnlinkedDirectory(handle.fd)).rejects.toThrow('source directory moved');
  await rm(directory, { recursive: true });
  await expect(backend.assertUnlinkedDirectory(handle.fd)).resolves.toBeUndefined();
});
