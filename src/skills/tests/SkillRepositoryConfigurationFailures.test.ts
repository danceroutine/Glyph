import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { HostExecutionAuthority } from '#src/shell/HostExecutionAuthority.js';
import { HostProcessLeases } from '#src/shell/HostProcessLeases.js';
import { Deferred } from '#src/shared/Deferred.js';
import { captureRepositoryEnvironment } from '#src/skills/SkillRepositoryConfiguration.js';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';

vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, userInfo: vi.fn(os.userInfo) };
});
const parser = vi.hoisted(() => ({
  replies: [] as (string | Error)[],
  executionDirectory: '/fixture/git-core' as string | Error,
  commands: [] as string[][],
  environments: [] as NodeJS.ProcessEnv[],
  started: undefined as ((child: EventEmitter, signal: AbortSignal) => void) | undefined,
  sshAvailable: true,
  inputError: false,
}));
vi.mock('node:child_process', () => ({
  execFile: (
    _path: string,
    args: string[],
    options: { signal: AbortSignal; env: NodeJS.ProcessEnv },
    callback: (error: Error | null, output: Buffer | string) => void,
  ) => {
    parser.commands.push(args);
    parser.environments.push({ ...options.env });
    const child = new EventEmitter();
    const stdin = new EventEmitter();
    const complete = () => {
      if (parser.started) {
        options.signal.addEventListener(
          'abort',
          () => {
            callback(new Error('Parser cancelled'), Buffer.alloc(0));
          },
          {
            once: true,
          },
        );
        parser.started(child, options.signal);
        return;
      }
      const next = args.includes('--exec-path') ? parser.executionDirectory : parser.replies.shift()!;
      queueMicrotask(() => {
        if (parser.inputError) stdin.emit('error', new Error('Configuration input closed'));
        if (next instanceof Error) callback(next, Buffer.alloc(0));
        else callback(null, Buffer.from(next));
        child.emit('close', next instanceof Error ? 1 : 0);
      });
    };
    return Object.assign(child, { stdin: Object.assign(stdin, { end: complete }) });
  },
}));
vi.mock('#src/shell/TrustedHostExecutable.js', async importOriginal => ({
  ...(await importOriginal<typeof import('#src/shell/TrustedHostExecutable.js')>()),
  trustedHostExecutable: (name: string) => {
    if (name === 'ssh' && !parser.sshAvailable) throw new Error('SSH unavailable');
    return '/fixture/' + name;
  },
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
  parser.commands = [];
  parser.environments = [];
  parser.started = undefined;
  parser.sshAvailable = true;
  parser.inputError = false;
  parser.executionDirectory = '/fixture/git-core';
  return {
    config,
    root,
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
  const f = await fixture('[http]\nextraHeader = "' + '\\\\'.repeat(8192) + '"\n');
  const entry = `http.extraheader\n${value}\0`;
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
  parser.replies.push(`global\0file:${f.config}\0${value}`, value);
  parser.executionDirectory = new Error('Git installation unavailable');
  await expect(f.capture()).rejects.toThrow('Git installation unavailable');
});

it.each([1, 2])('rechecks workspace authority at the handoff to configuration child %s', async target => {
  const f = await fixture();
  let roots: string[] = [];
  let checks = 0;
  let arm = false;
  const readRoots = () => {
    if (arm) {
      arm = false;
      queueMicrotask(() => {
        roots = [f.root];
      });
    }
    return roots;
  };
  const metadata = {
    ...testFilesystemMetadata,
    assertHostPaths: async () => {
      arm = ++checks === target;
    },
  };
  const authority = new HostExecutionAuthority(readRoots, metadata);
  await expect(
    captureRepositoryEnvironment([], f.root, new AbortController().signal, metadata, undefined, authority),
  ).rejects.toThrow('workspace authority changed');
  expect(parser.commands).toHaveLength(target - 1);
});

it('holds a cancelled configuration process lease until child close, including an early execFile callback', async () => {
  const f = await fixture();
  const leases = new HostProcessLeases([]);
  const authority = new HostExecutionAuthority(leases, testFilesystemMetadata);
  const started = new Deferred<EventEmitter>();
  const stopped = new Deferred<void>();
  parser.started = (child, signal) => {
    signal.addEventListener(
      'abort',
      () => {
        stopped.resolve();
      },
      { once: true },
    );
    started.resolve(child);
  };
  const parsing = captureRepositoryEnvironment(
    [],
    f.root,
    new AbortController().signal,
    testFilesystemMetadata,
    undefined,
    authority,
  );
  const rejected = expect(parsing).rejects.toThrow('Parser cancelled');
  const child = await started.promise;
  const publish = vi.fn();
  const admission = leases.admitWorkspace(() => [f.root], publish);
  await stopped.promise;
  expect(publish).not.toHaveBeenCalled();
  child.emit('close', 1);
  await rejected;
  await admission;
  expect(publish).toHaveBeenCalledOnce();
  parser.started = undefined;
  parser.replies.push('');
  await expect(f.capture()).resolves.toHaveProperty('GIT_CONFIG_GLOBAL');
});

it.each(['missing', 'denied'])('refuses the selected SSH transport when its client is %s', async kind => {
  const f = await fixture();
  parser.sshAvailable = kind !== 'missing';
  parser.replies.push('', 'git@mirror.invalid:fixture.git\n');
  const metadata = {
    ...testFilesystemMetadata,
    assertHostPaths: async (paths: readonly string[]) => {
      if (paths.includes('/fixture/ssh')) throw new Error('SSH is workspace-controlled');
    },
  };
  await expect(
    captureRepositoryEnvironment(
      [],
      f.root,
      new AbortController().signal,
      metadata,
      'source.git',
      new HostExecutionAuthority([], metadata),
      vi.fn(),
    ),
  ).rejects.toThrow(/SSH (?:is workspace-controlled|unavailable)/u);
});

it('rejects an account home that OpenSSH would interpret as an environment reference', async () => {
  const f = await fixture();
  parser.replies.push('', 'ssh://fixture.invalid/package\n');
  vi.mocked(userInfo).mockReturnValueOnce({ ...userInfo(), homedir: f.root + '/${INVOCATION}' });
  await expect(
    captureRepositoryEnvironment(
      [],
      f.root,
      new AbortController().signal,
      testFilesystemMetadata,
      'source.git',
      undefined,
      vi.fn(),
    ),
  ).rejects.toThrow('literal OpenSSH file names');
});

it.each([undefined, 'C:\\KnownData'])(
  'leases the Windows system SSH host-key files with ProgramData %s',
  async data => {
    const f = await fixture();
    parser.replies.push('', 'ssh://fixture.invalid/package\n');
    vi.stubEnv('ProgramData', data);
    vi.stubEnv('SSH_AUTH_SOCK', undefined);
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const env = await captureRepositoryEnvironment(
      [],
      f.root,
      new AbortController().signal,
      testFilesystemMetadata,
      'source.git',
      undefined,
      vi.fn(),
    );
    expect(env.GIT_SSH_COMMAND).toContain('GlobalKnownHostsFile=');
    expect(env.GIT_SSH_COMMAND).toContain(data ? 'KnownData' : 'ProgramData');
    expect(env.GIT_ALLOW_PROTOCOL).toBe('ssh');
  },
);
it('settles a parser whose input pipe closes before Git completes', async () => {
  const f = await fixture();
  parser.inputError = true;
  await expect(f.capture()).rejects.toThrow('Configuration input closed');
});

it('starts every discovery process with ambient Git configuration and trace outputs disabled', async () => {
  const f = await fixture();
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', undefined);
  const system = join(f.root, 'system.config');
  await writeFile(system, '[http]\nversion=HTTP/2\n');
  parser.replies.push(
    'file:' + system + '\0http.version\0',
    'command\0file:' + system + '\0http.version\nHTTP/2\0',
    'http.version\nHTTP/2\0',
  );
  const env = await f.capture();
  const controls = { GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0', GIT_CONFIG_NOSYSTEM: '1' };
  for (const process of parser.environments)
    expect(process).toMatchObject({ ...controls, GIT_CONFIG_GLOBAL: '/dev/null' });
  expect(parser.commands.find(command => command.includes('--includes'))).toEqual(
    expect.arrayContaining(['include.path=' + system, 'include.path=' + f.config]),
  );
  expect(env).toMatchObject(controls);
});

it('preserves system configuration lookup errors and handles installations without system settings', async () => {
  const f = await fixture();
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', undefined);
  parser.replies.push(Object.assign(new Error('No matching settings'), { code: 1 }), '');
  await expect(f.capture()).resolves.toHaveProperty('GIT_CONFIG_GLOBAL');
  parser.replies.push('standard input:\0http.version\0');
  await expect(f.capture()).rejects.toThrow('file origin');
  parser.replies.push(new Error('Could not inspect system configuration'));
  await expect(f.capture()).rejects.toThrow('Could not inspect system configuration');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '2');
  parser.replies.push('');
  await expect(f.capture()).resolves.toHaveProperty('GIT_CONFIG_GLOBAL');
});

it.each(['profile', 'account'])('uses the %s home for the HTTPS client when HOME is absent', async fallback => {
  const f = await fixture();
  vi.stubEnv('HOME', undefined);
  vi.stubEnv('USERPROFILE', fallback === 'profile' ? f.root : undefined);
  if (fallback === 'account') vi.mocked(userInfo).mockReturnValueOnce({ ...userInfo(), homedir: f.root });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const admitted = vi.fn(testFilesystemMetadata.assertHostPaths);
  const metadata = { ...testFilesystemMetadata, assertHostPaths: admitted };
  parser.replies.push('', 'https://fixture.invalid/package\n');
  const env = await captureRepositoryEnvironment(
    [],
    f.root,
    new AbortController().signal,
    metadata,
    'source.git',
    undefined,
    vi.fn(),
  );
  const physical = await realpath(f.root);
  expect(await realpath(env.HOME!)).toBe(physical);
  expect(admitted).toHaveBeenCalledWith(
    expect.arrayContaining([join(physical, '.netrc'), join(physical, '_netrc')]),
    [],
  );
});

it('rejects an unsupported effective remote before launching a fetch', async () => {
  const f = await fixture();
  parser.replies.push('', 'ftp://fixture.invalid/package\n');
  await expect(
    captureRepositoryEnvironment(
      [],
      f.root,
      new AbortController().signal,
      testFilesystemMetadata,
      'source.git',
      undefined,
      vi.fn(),
    ),
  ).rejects.toThrow('supports HTTPS, SSH and local');
});
