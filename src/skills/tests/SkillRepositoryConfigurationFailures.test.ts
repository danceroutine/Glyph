import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { captureRepositoryEnvironment } from '#src/skills/SkillRepositoryConfiguration.js';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';

const parser = vi.hoisted(() => ({ replies: [] as (string | Error)[] }));
vi.mock('node:child_process', () => ({
  execFile: (
    _path: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, output: string) => void,
  ) => ({
    stdin: {
      end: () => {
        const next = parser.replies.shift()!;
        queueMicrotask(() => (next instanceof Error ? callback(next, '') : callback(null, next)));
      },
    },
  }),
}));
vi.mock('#src/shell/TrustedHostExecutable.js', async importOriginal => ({
  ...(await importOriginal<typeof import('#src/shell/TrustedHostExecutable.js')>()),
  trustedHostExecutable: () => '/fixture/git',
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', platform);
});
async function fixture(contents = '[core]\neditor = trusted\n') {
  const root = await mkdtemp(join(tmpdir(), 'glyph-config-provenance-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'trusted.config');
  await writeFile(config, contents);
  vi.stubEnv('HOME', root);
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  parser.replies = [];
  return {
    config,
    capture: () => captureRepositoryEnvironment([], root, new AbortController().signal, testFilesystemMetadata),
  };
}
it('rejects malformed origins and values that changed between parser discovery and descriptor capture', async () => {
  const f = await fixture();
  parser.replies.push('orphan\0');
  await expect(f.capture()).rejects.toThrow('invalid configuration origins');
  parser.replies.push('unterminated');
  await expect(f.capture()).rejects.toThrow('invalid configuration origins');
  parser.replies.push('command line:\0core.editor\nuntrusted\0');
  await expect(f.capture()).rejects.toThrow('trusted file origin');
  parser.replies.push(`file:${f.config}\0core.editor\nuntrusted\0`, 'core.editor\ntrusted\0');
  await expect(f.capture()).rejects.toThrow('changed during capture');
  parser.replies.push(new Error('Malformed included config'));
  await expect(f.capture()).rejects.toThrow('Malformed included config');
});
it('bounds the flattened configuration even when repeated trusted includes expand escaped values', async () => {
  const value = '\\'.repeat(8192);
  const f = await fixture('[custom]\nitem = "' + '\\\\'.repeat(8192) + '"\n');
  const entry = `custom.item\n${value}\0`;
  parser.replies.push((`file:${f.config}\0` + entry).repeat(100), entry);
  await expect(f.capture()).rejects.toThrow('capture budget');
});
it('disables the system configuration explicitly on Windows too', async () => {
  const f = await fixture();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  parser.replies.push('');
  expect(await f.capture()).toMatchObject({ GIT_CONFIG_SYSTEM: 'NUL', GIT_CONFIG_NOSYSTEM: '1' });
});
