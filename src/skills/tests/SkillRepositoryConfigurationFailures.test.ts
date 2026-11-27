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
    args: string[],
    _options: unknown,
    callback: (error: Error | null, output: Buffer) => void,
  ) => {
    const complete = () => {
      const next = parser.replies.shift()!;
      queueMicrotask(() => {
        if (next instanceof Error) callback(next, Buffer.alloc(0));
        else callback(null, Buffer.from(next));
      });
    };
    if (args.includes('--exec-path')) complete();
    return { stdin: { end: complete } };
  },
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
  parser.replies.push('command\0command line:\0core.editor\nuntrusted\0');
  await expect(f.capture()).rejects.toThrow('trusted file origin');
  parser.replies.push(`global\0file:${f.config}\0core.editor\nuntrusted\0`, 'core.editor\ntrusted\0');
  await expect(f.capture()).rejects.toThrow('changed during capture');
  parser.replies.push(new Error('Malformed included config'));
  await expect(f.capture()).rejects.toThrow('Malformed included config');
});
it('bounds the flattened configuration even when repeated trusted includes expand escaped values', async () => {
  const value = '\\'.repeat(8192);
  const f = await fixture('[custom]\nitem = "' + '\\\\'.repeat(8192) + '"\n');
  const entry = `custom.item\n${value}\0`;
  parser.replies.push((`global\0file:${f.config}\0` + entry).repeat(100), entry);
  await expect(f.capture()).rejects.toThrow('capture budget');
});
it('disables the system configuration explicitly on Windows too', async () => {
  const f = await fixture();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  parser.replies.push('');
  expect(await f.capture()).toMatchObject({ GIT_CONFIG_SYSTEM: 'NUL', GIT_CONFIG_NOSYSTEM: '1' });
});

it('stops capture when Git cannot resolve its credential helper installation', async () => {
  const f = await fixture('[credential]\nhelper = store\n');
  const value = 'credential.helper\nstore\0';
  parser.replies.push(`global\0file:${f.config}\0${value}`, value, new Error('Git installation unavailable'));
  await expect(f.capture()).rejects.toThrow('Git installation unavailable');
});
