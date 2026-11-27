import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
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
