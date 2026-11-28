import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { NativeFilesystemMetadata } from '../NativeFilesystemMetadata.ts';
import { NativePinnedSourceAuthority } from '../PinnedSourceAuthority.ts';
import { authorizeSources, enrollSources, sourceReads } from '../SourceDisclosure.ts';
import { WorkspaceAccessPolicy } from '../policy/WorkspaceAccessPolicy.ts';

it('retries unavailable catalog reads against their original identity and isolates invalid source URIs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glyph-enrolled-sources-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const present = join(root, 'present');
  const missing = join(root, 'missing');
  await writeFile(present, 'present');
  await writeFile(missing, 'missing');
  const authority = new NativePinnedSourceAuthority(
    new NativeFilesystemMetadata(resolve('target/release/glyph-context-index')),
    new WorkspaceAccessPolicy(),
    () => {},
  );
  const sources = await Promise.all(
    [present, missing].map(async path => {
      const entry = await stat(path, { bigint: true });
      return {
        id: path,
        [sourceReads]: { authority, files: [{ uri: pathToFileURL(path).href, identity: entry.dev + ':' + entry.ino }] },
      };
    }),
  );
  await rename(missing, missing + '-saved');
  const pins = await enrollSources([
    ...sources,
    { id: 'invalid', [sourceReads]: { authority, files: [{ uri: 'untitled:guide', identity: '1:2' }] } },
    { id: 'no-origin' },
  ]);
  expect(pins.has('no-origin')).toBe(false);
  await expect(authorizeSources(pins.get(present)!)).resolves.toBeTypeOf('function');
  await expect(authorizeSources(pins.get('invalid')!)).rejects.toThrow();
  await expect(authorizeSources(pins.get(missing)!)).rejects.toThrow('inspection failed');
  await rename(missing + '-saved', missing);
  await expect(authorizeSources(pins.get(missing)!)).resolves.toBeTypeOf('function');
});
