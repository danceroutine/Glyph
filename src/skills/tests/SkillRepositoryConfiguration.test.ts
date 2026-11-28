import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { SkillRepositoryCredentialHelpers } from '#src/skills/SkillRepositoryCredentialHelpers.js';
import { captureRepositoryEnvironment } from '#src/skills/SkillRepositoryConfiguration.js';
import { HostProcessLeases } from '#src/shell/HostProcessLeases.js';
import { HostExecutionAuthority } from '#src/shell/HostExecutionAuthority.js';
import { Deferred } from '#src/shared/Deferred.js';
import { trustedHostExecutable } from '#src/shell/TrustedHostExecutable.js';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';

afterEach(() => vi.unstubAllEnvs());
async function fixture(temporary = tmpdir()) {
  const base = await mkdtemp(join(temporary, 'glyph-git-configuration-'));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const project = join(base, 'project');
  const preview = join(base, 'preview');
  for (const path of [home, project, preview]) await mkdir(path, { mode: 0o700 });
  const global = join(home, 'global.config');
  await writeFile(global, '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', undefined);
  vi.stubEnv('GIT_CONFIG_GLOBAL', global);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  const capture = () =>
    captureRepositoryEnvironment([project], preview, new AbortController().signal, testFilesystemMetadata);
  return { home, project, preview, global, capture };
}

it('rejects active transitive includes from writable workspaces before a transport can use their settings', async () => {
  const f = await fixture();
  const included = join(f.home, 'included.config');
  await writeFile(f.global, '[include]\npath = included.config\n');
  await writeFile(included, `[include]\npath = ${join(f.project, 'workspace.config')}\n`);
  await writeFile(join(f.project, 'workspace.config'), '[user]\nname = Workspace controlled\n');
  await expect(f.capture()).rejects.toThrow('outside writable workspaces');
});

it('pins trusted include values, repeated values, bare booleans and escaped subsection strings for the entire preview', async () => {
  const f = await fixture();
  const included = join(f.home, 'included.config');
  await writeFile(f.global, '[include]\npath = included.config\n[user]\nname = Trusted user\n[fetch]\nprune\n');
  await writeFile(
    included,
    '[credential]\nhelper = store\nhelper = cache\n[url "https://trusted.invalid/a"]\ninsteadOf = "https://example.invalid/\\t\\n\\b\\\\\\\""\n',
  );
  const environment = await f.capture();
  const git = (...args: string[]) =>
    execFileSync(trustedHostExecutable('git', [f.project]), ['config', ...args], {
      cwd: f.preview,
      env: environment,
      encoding: 'utf8',
    });
  expect(git('--get-all', 'credential.helper')).toMatch(/^!exec '[^\n]+git-credential-store'\n!:\n$/u);
  expect(git('--bool', '--get', 'fetch.prune')).toBe('true\n');
  expect(git('--get', 'user.name')).toBe('Trusted user\n');
  expect(git('--get', 'url.https://trusted.invalid/a.insteadOf')).toBe('https://example.invalid/\t\n\b\\"\n');
  await writeFile(included, '[user]\nname = Changed after capture\n');
  await writeFile(f.global, `[include]\npath = ${join(f.project, 'later.config')}\n`);
  expect(git('--get', 'user.name')).toBe('Trusted user\n');
  expect(await readFile(environment.GIT_CONFIG_GLOBAL!, 'utf8')).not.toContain('[include]');
});

it('keeps an empty configuration private and propagates cancellation and metadata rejection', async () => {
  const f = await fixture();
  const environment = await f.capture();
  expect(await readFile(environment.GIT_CONFIG_GLOBAL!, 'utf8')).toBe('');
  await expect(
    captureRepositoryEnvironment([f.project], f.preview, new AbortController().signal, {
      assertHostPaths: async () => {},
      inspect: async () => {
        throw new Error('Inherited ACL');
      },
    }),
  ).rejects.toThrow('Inherited ACL');
  const controller = new AbortController();
  controller.abort();
  await expect(
    captureRepositoryEnvironment([f.project], f.preview, controller.signal, testFilesystemMetadata),
  ).rejects.toThrow();
});

it('removes conditional directives containing a Unicode line separator and retains literal subsection characters', async () => {
  const f = await fixture();
  const separator = String.fromCodePoint(0x2028);
  const subsection = 'one\ttwo\bthree' + String.fromCodePoint(92) + 'four';
  const repository = 'project' + separator + 'name.git';
  const condition = 'gitdir:**/' + repository;
  const git = trustedHostExecutable('git', [f.project]);
  execFileSync(git, ['init', '--bare', '--quiet', '--template=', repository], { cwd: f.preview });
  const included = join(f.home, 'future.config');
  await writeFile(included, '[user]\nname = First\n');
  const settings = ['config', '--file', f.global];
  execFileSync(git, [...settings, 'includeif.' + condition + '.path', 'future.config']);
  execFileSync(git, [...settings, 'credential.' + subsection + '.username', 'preserved']);
  const env = await captureRepositoryEnvironment(
    [f.project],
    f.preview,
    new AbortController().signal,
    testFilesystemMetadata,
    repository,
  );
  await writeFile(included, '[user]\nname = Second\n');
  expect(execFileSync(git, ['config', '--get', 'user.name'], { cwd: f.preview, env, encoding: 'utf8' }).trim()).toBe(
    'First',
  );
  expect(await readFile(env.GIT_CONFIG_GLOBAL!, 'utf8')).not.toContain('future.config');
  expect(
    execFileSync(git, ['config', '--get', 'credential.' + subsection + '.username'], {
      cwd: f.preview,
      env,
      encoding: 'utf8',
    }).trim(),
  ).toBe('preserved');
});

it('rejects settings whose bytes cannot round-trip through a UTF-8 configuration snapshot', async () => {
  const f = await fixture();
  await writeFile(f.global, Buffer.concat([Buffer.from('[user]\nname = '), Buffer.from([0xff]), Buffer.from('\n')]));
  await expect(f.capture()).rejects.toThrow(/utf-8/iu);
});

it('uses an admitted absolute helper without evaluating its filename as shell syntax', async () => {
  const f = await fixture();
  const helper = join(f.home, "host'helper");
  await writeFile(helper, "#!/bin/sh\nprintf 'username=fixture\\npassword=fixture\\n'\n");
  await chmod(helper, 0o700);
  await writeFile(f.global, `[credential]\nhelper = ${helper}\n`);
  const env = await f.capture();
  expect(
    execFileSync(trustedHostExecutable('git', []), ['credential', 'fill'], {
      cwd: f.preview,
      env,
      input: 'protocol=https\nhost=fixture.invalid\n\n',
      encoding: 'utf8',
    }),
  ).toContain('username=fixture\npassword=fixture');
});

it('refuses workspace-controlled helpers and shell fragments before transport can execute them', async () => {
  const f = await fixture();
  const helper = join(f.project, 'helper');
  await writeFile(helper, '#!/bin/sh\nexit 0\n');
  await chmod(helper, 0o700);
  await writeFile(f.global, `[credential]\nhelper = ${helper}\n`);
  await expect(f.capture()).rejects.toThrow('outside writable workspaces');
  for (const value of ['!echo unreviewed', 'store --file credentials']) {
    await writeFile(f.global, `[credential]\nhelper = ${value}\n`);
    await expect(f.capture()).rejects.toThrow('without arguments');
  }
  await writeFile(f.global, `[credential]\nhelper = ${f.home}\n`);
  await expect(f.capture()).rejects.toThrow('executable file');
});

it('retains credential reset entries and blocks command-valued transport overrides', async () => {
  const f = await fixture();
  await writeFile(f.global, '[credential]\nhelper =\n[remote "origin"]\nproxy = http://fixture.invalid:8080\n');
  const env = await f.capture();
  expect(
    execFileSync(trustedHostExecutable('git', []), ['config', '--get-all', 'credential.helper'], {
      cwd: f.preview,
      env,
      encoding: 'utf8',
    }),
  ).toBe('\n');
  expect(
    execFileSync(trustedHostExecutable('git', []), ['config', '--get', 'remote.origin.proxy'], {
      cwd: f.preview,
      env,
      encoding: 'utf8',
    }),
  ).toBe('http://fixture.invalid:8080\n');
  for (const [section, key] of [
    ['core', 'sshCommand'],
    ['core', 'gitProxy'],
    ['core', 'askPass'],
    ['core', 'alternateRefsCommand'],
    ['uploadpack', 'packObjectsHook'],
    ['remote "origin"', 'uploadpack'],
    ['remote "origin"', 'vcs'],
  ]) {
    await writeFile(f.global, `[${section}]\n${key} = arbitrary-command\n`);
    await expect(f.capture()).rejects.toThrow('command-valued Git transport');
  }
});

it.each(['https://fixture.invalid/package', 'ssh://git@fixture.invalid/package', 'git@fixture.invalid:package'])(
  'admits SSH inputs only when the configured remote selects SSH at %s',
  async remote => {
    const f = await fixture();
    const git = trustedHostExecutable('git', []);
    const url = 'https://package.invalid/selected';
    execFileSync(git, ['init', '--bare', '--quiet', '--template=', 'source.git'], { cwd: f.preview });
    execFileSync(git, ['--git-dir=source.git', 'remote', 'add', 'origin', url], { cwd: f.preview });
    await writeFile(f.global, `[url "${remote}"]\ninsteadOf = ${url}\n`);
    const socket = join(f.project, 'agent');
    vi.stubEnv('SSH_AUTH_SOCK', socket);
    const select = vi.fn();
    const admitted = vi.fn(testFilesystemMetadata.assertHostPaths);
    const metadata = { ...testFilesystemMetadata, assertHostPaths: admitted };
    const capture = (roots: string[]) =>
      captureRepositoryEnvironment(
        roots,
        f.preview,
        new AbortController().signal,
        metadata,
        'source.git',
        new HostExecutionAuthority(roots, metadata),
        select,
      );
    const keyDirectory = join(userInfo().homedir, '.ssh');
    if (remote.startsWith('https:')) {
      const env = await capture([f.project, keyDirectory]);
      expect(env.GIT_ALLOW_PROTOCOL).toBe('https');
      expect(env.GIT_SSH_COMMAND).toBeUndefined();
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
    } else {
      await expect(capture([f.project])).rejects.toThrow('outside writable workspaces');
      await expect(capture([keyDirectory])).rejects.toThrow('outside writable workspaces');
      const env = await capture([]);
      expect(env.GIT_ALLOW_PROTOCOL).toBe('ssh');
      const command = env.GIT_SSH_COMMAND!;
      const options = execFileSync('/bin/sh', ['-c', command + ' -G fixture.invalid'], { env, encoding: 'utf8' });
      expect(options).toContain('identityfile ' + join(keyDirectory, 'id_ed25519'));
      expect(options).toContain('userknownhostsfile ' + join(keyDirectory, 'known_hosts'));
      expect(options).toContain('globalknownhostsfile /etc/ssh/ssh_known_hosts');
      expect(options).toMatch(/^identityagent SSH_AUTH_SOCK$/mu);
      expect(env.SSH_AUTH_SOCK).toBe(join(await realpath(f.project), 'agent'));
      expect(admitted).toHaveBeenCalledWith(
        expect.arrayContaining([
          join(keyDirectory, 'id_ed25519.pub'),
          join(keyDirectory, 'id_ed25519-cert.pub'),
          socket,
        ]),
        [],
        expect.arrayContaining([socket]),
      );
      vi.stubEnv('SSH_AUTH_SOCK', 'relative');
      await expect(capture([])).rejects.toThrow('absolute socket path');
      vi.stubEnv('SSH_AUTH_SOCK', undefined);
      const noAgent = await capture([]);
      expect(noAgent.GIT_SSH_COMMAND).toContain('IdentityAgent=none');
    }
    expect(select).not.toHaveBeenCalled();
  },
);

it.each([
  'cookieFile',
  'sslCert',
  'sslKey',
  'sslCAInfo',
  'proxySSLCert',
  'proxySSLKey',
  'proxySSLCAInfo',
  'pinnedPubkey',
])('rejects URL-scoped HTTP %s controlled by a workspace', async option => {
  const f = await fixture();
  await writeFile(f.global, '[http "https://remote.invalid"]\n' + option + ' = ' + join(f.project, 'fixture') + '\n');
  await expect(f.capture()).rejects.toThrow('outside writable workspaces');
});

it('retains hash pins and leases home-relative cookies from capture through the end of transport', async () => {
  const f = await fixture();
  const hashes = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)]
    .map(bytes => 'sha256//' + bytes.toString('base64'))
    .join(';');
  await writeFile(
    f.global,
    '[http]\npinnedPubkey = "' +
      hashes +
      '"\nsaveCookies = true\n[http "https://remote.invalid"]\ncookieFile = ~/jar\n',
  );
  const leases = new HostProcessLeases([f.project]);
  const authority = new HostExecutionAuthority(leases, testFilesystemMetadata);
  const signal = new AbortController().signal;
  const env = await captureRepositoryEnvironment(
    [f.project],
    f.preview,
    signal,
    testFilesystemMetadata,
    undefined,
    authority,
  );
  const get = (key: string) =>
    execFileSync(trustedHostExecutable('git', []), ['config', '--get', key], {
      cwd: f.preview,
      env,
      encoding: 'utf8',
    }).trim();
  const jar = join(await realpath(f.home), 'jar');
  expect(get('http.https://remote.invalid.cookieFile')).toBe(jar);
  expect(get('http.saveCookies')).toBe('true');
  expect(get('http.pinnedPubkey')).toBe(hashes);
  const started = new Deferred<void>();
  const stopped = new Deferred<void>();
  const close = new Deferred<void>();
  const transport = authority.run(signal, processSignal => {
    processSignal.addEventListener(
      'abort',
      () => {
        stopped.resolve();
      },
      { once: true },
    );
    started.resolve();
    return close.promise;
  });
  const rejected = expect(transport).rejects.toThrow('workspace is attaching');
  await started.promise;
  const publish = vi.fn();
  const admission = leases.admitWorkspace(() => [jar], publish);
  await stopped.promise;
  expect(publish).not.toHaveBeenCalled();
  close.resolve();
  await Promise.all([rejected, admission]);
  expect(publish).toHaveBeenCalledOnce();
});

it.each([['cookieFile', 'relative']])('requires an unambiguous host path for HTTP %s', async (key, value) => {
  const f = await fixture();
  await writeFile(f.global, '[http]\n' + key + ' = ' + value + '\n');
  await expect(f.capture()).rejects.toThrow('one absolute path');
});

it('requires an admitted CA bundle and a network endpoint for configured proxies', async () => {
  const f = await fixture();
  await writeFile(f.global, '[http]\nsslCAPath = ' + f.home + '\n');
  await expect(f.capture()).rejects.toThrow('sslCAInfo certificate bundle');
  for (const section of ['http "https://remote.invalid"', 'remote "origin"']) {
    await writeFile(f.global, '[' + section + ']\nproxy = socks5h://localhost/socket\n');
    await expect(f.capture()).rejects.toThrow('network proxy endpoints');
  }
  await writeFile(f.global, '');
  vi.stubEnv('http_proxy', 'socks4a://localhost/socket');
  await expect(f.capture()).rejects.toThrow('network proxy endpoints');
});

it('captures only preview settings from the XDG and home config in precedence order', async () => {
  const f = await fixture();
  vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
  const xdg = join(f.home, 'xdg');
  vi.stubEnv('XDG_CONFIG_HOME', xdg);
  await mkdir(join(xdg, 'git'), { recursive: true });
  await writeFile(join(xdg, 'git/config'), '[http]\nextraHeader = X-Fixture: xdg\n');
  await writeFile(
    join(f.home, '.gitconfig'),
    '[http]\nextraHeader = X-Fixture: home\n[color]\nui = always\n[alias]\nstatusfixture = status\n',
  );
  const env = await f.capture();
  expect(
    execFileSync(trustedHostExecutable('git', []), ['config', '--get-all', 'http.extraHeader'], {
      env,
      cwd: f.preview,
      encoding: 'utf8',
    }),
  ).toBe('X-Fixture: xdg\nX-Fixture: home\n');
  expect(await readFile(env.GIT_CONFIG_GLOBAL!, 'utf8')).not.toMatch(/\[color\]|\[alias\]/u);
});

it.each([
  '.netrc',
  '.git-credentials',
  '.git-credentials.lock',
  '.config/git/credentials',
  '.config/git/credentials.lock',
])('leases the future HTTPS credential path %s until the current process closes', async relative => {
  const f = await fixture();
  const git = trustedHostExecutable('git', []);
  execFileSync(git, ['init', '--bare', '--quiet', '--template=', 'source.git'], { cwd: f.preview });
  execFileSync(git, ['--git-dir=source.git', 'remote', 'add', 'origin', 'https://fixture.invalid/repo'], {
    cwd: f.preview,
  });
  await writeFile(f.global, '[credential]\nhelper = store\n');
  const leases = new HostProcessLeases([]);
  const authority = new HostExecutionAuthority(leases, testFilesystemMetadata);
  const signal = new AbortController().signal;
  await captureRepositoryEnvironment([], f.preview, signal, testFilesystemMetadata, 'source.git', authority, vi.fn());
  const started = new Deferred<void>();
  const stopped = new Deferred<void>();
  const close = new Deferred<void>();
  const process = authority.run(signal, current => {
    current.addEventListener(
      'abort',
      () => {
        stopped.resolve();
      },
      { once: true },
    );
    started.resolve();
    return close.promise;
  });
  const rejected = expect(process).rejects.toThrow('workspace is attaching');
  await started.promise;
  const publish = vi.fn();
  const attach = leases.admitWorkspace(() => [join(f.home, relative)], publish);
  await stopped.promise;
  expect(publish).not.toHaveBeenCalled();
  close.resolve();
  await Promise.all([rejected, attach]);
  expect(publish).toHaveBeenCalledOnce();
});

it('honors a disabled global config and retains transport integrity and ref visibility controls', async () => {
  const f = await fixture();
  await writeFile(f.global, '[fetch]\nfsckObjects = true\n[uploadpack]\nhideRefs = refs/private\n');
  const configured = await f.capture();
  const settings = await readFile(configured.GIT_CONFIG_GLOBAL!, 'utf8');
  expect(settings).toContain('fsckobjects = "true"');
  expect(settings).toContain('hiderefs = "refs/private"');
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  const admitted = vi.fn(testFilesystemMetadata.assertHostPaths);
  const env = await captureRepositoryEnvironment([], f.preview, new AbortController().signal, {
    ...testFilesystemMetadata,
    assertHostPaths: admitted,
  });
  expect(await readFile(env.GIT_CONFIG_GLOBAL!, 'utf8')).toBe('');
  expect(admitted.mock.calls.flatMap(call => call[0])).not.toContain('/dev/null');
});

async function credentialCacheFixture() {
  const f = await fixture(await realpath('/tmp'));
  const git = trustedHostExecutable('git', []);
  const cwd = f.preview;
  execFileSync(git, ['init', '--bare', '--quiet', '--template=', 'source.git'], { cwd });
  execFileSync(git, ['--git-dir=source.git', 'remote', 'add', 'origin', 'https://fixture.invalid/selected'], { cwd });
  const configured = join(f.home, "user's cache");
  const legacy = join(f.home, '.git-credential-cache');
  vi.stubEnv('XDG_CACHE_HOME', configured);
  await writeFile(f.global, '[credential]\nhelper = store\nhelper = cache\n');
  const checks = vi.fn(testFilesystemMetadata.assertHostPaths);
  const metadata = { ...testFilesystemMetadata, assertHostPaths: checks };
  let roots = [f.project];
  const leases = new HostProcessLeases(() => roots);
  const attach = (root: string) =>
    leases.admitWorkspace(
      () => [...roots, root],
      updated => {
        roots = [...updated];
      },
    );
  const authority = new HostExecutionAuthority(leases, metadata);
  const secondary = new SkillRepositoryCredentialHelpers(authority);
  const signal = new AbortController().signal;
  const capture = () =>
    captureRepositoryEnvironment([f.project], cwd, signal, metadata, 'source.git', authority, vi.fn(), secondary);
  const credential = (
    env: NodeJS.ProcessEnv,
    operation: 'fill' | 'approve' | 'reject',
    url = 'https://fixture.invalid/selected',
  ) =>
    authority.run(signal, (active, include) =>
      secondary.run(cwd, env, active, include, async (environment, processSignal) => {
        const child = spawn(git, ['--git-dir=source.git', 'credential', operation], {
          cwd,
          env: environment,
          signal: processSignal,
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        const done = new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        const value = operation === 'fill' ? '' : 'username=fixture\npassword=fixture-only\n';
        child.stdin.end('url=' + url + '\n' + value + '\n');
        return done;
      }),
    );
  return { ...f, configured, legacy, checks, capture, credential, attach };
}

/** This disposable endpoint serves a synthetic account for fixture.invalid. */
async function fixtureCacheDaemon(directory: string, name = 'socket') {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const actions: string[] = [];
  const server = createServer(client => {
    let request = '';
    client.on('data', chunk => {
      request += chunk.toString('utf8');
    });
    client.on('end', () => {
      const action = request.split('\n')[0]!;
      actions.push(action);
      client.end(action === 'action=get' ? 'username=fixture\npassword=fixture-only\n\n' : '');
    });
  });
  const opened = once(server, 'listening');
  server.listen(join(directory, name));
  await opened;
  const close = async () => {
    const closed = once(server, 'close');
    server.close();
    await closed;
  };
  return { actions, close };
}

it.skipIf(process.platform === 'win32').each(['legacy', 'XDG', 'home'])(
  'uses the existing %s endpoint for credential cache lookup, storage and erasure',
  async kind => {
    const f = await credentialCacheFixture();
    if (kind === 'home') vi.stubEnv('XDG_CACHE_HOME', 'relative path');
    const directory =
      kind === 'legacy'
        ? join(f.home, 'account cache')
        : join(kind === 'home' ? join(f.home, '.cache') : f.configured, 'git/credential');
    const daemon = await fixtureCacheDaemon(directory);
    onTestFinished(daemon.close);
    if (kind === 'legacy') await symlink(directory, f.legacy);
    const env = await f.capture();
    const socket = join(directory, 'socket');
    expect(f.checks).toHaveBeenCalledWith(
      expect.any(Array),
      [f.project],
      expect.arrayContaining([kind === 'legacy' ? join(f.legacy, 'socket') : socket, socket]),
    );
    // The preview keeps using the same socket if the account's default changes.
    if (kind !== 'legacy') await mkdir(f.legacy);
    vi.stubEnv('XDG_CACHE_HOME', f.project);
    expect(await f.credential(env, 'approve')).toBe(0);
    expect(await stat(join(f.home, '.git-credentials'))).toBeDefined();
    expect(await f.credential(env, 'reject')).toBe(0);
    expect(await f.credential(env, 'fill')).toBe(0);
    expect(daemon.actions).toEqual(['action=store', 'action=erase', 'action=get']);
  },
);

it.skipIf(process.platform === 'win32').each(['missing', 'stale'])(
  'keeps the store helper working when the selected cache socket is %s',
  async kind => {
    const f = await credentialCacheFixture();
    const directory = join(f.configured, 'git/credential');
    const socket = join(directory, 'socket');
    if (kind === 'stale') {
      const daemon = await fixtureCacheDaemon(directory, 'original');
      // Closing the listener at its old name leaves the new name without a live daemon.
      await rename(join(directory, 'original'), socket);
      await daemon.close();
    }
    const env = await f.capture();
    expect(await f.credential(env, 'approve')).toBe(0);
    expect(await stat(join(f.home, '.git-credentials'))).toBeDefined();
    if (kind === 'missing') {
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      const connection = createConnection(socket);
      try {
        await expect(once(connection, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      } finally {
        connection.destroy();
      }
    }
  },
);

it.skipIf(process.platform === 'win32')('refuses a shared cache routed into an attached workspace', async () => {
  const f = await credentialCacheFixture();
  await symlink(f.project, f.legacy);
  await expect(f.capture()).rejects.toThrow('outside writable workspaces');
});

it.skipIf(process.platform === 'win32')('honors a helper reset before selecting credential-cache inputs', async () => {
  const f = await credentialCacheFixture();
  await writeFile(f.global, '[credential]\nhelper = cache\nhelper =\nhelper = store\n');
  const env = await f.capture();
  expect(await readFile(env.GIT_CONFIG_GLOBAL!, 'utf8')).not.toContain('--socket');
  expect(f.checks.mock.calls.flatMap(([paths]) => paths)).not.toContain(join(f.configured, 'git/credential/socket'));
});

it.skipIf(process.platform === 'win32').each(['false', 'initial', 'true'])(
  'honors matching helper resets and the original order with followRedirects=%s',
  async redirects => {
    const f = await credentialCacheFixture();
    const inaccessible = join(f.project, 'helper');
    const first = join(f.home, 'first-helper'),
      second = join(f.home, 'second-helper');
    await writeFile(first, '#!/bin/sh\necho "$1" >> "$0.log"\necho username=fixture\n', { mode: 0o700 });
    await writeFile(second, '#!/bin/sh\necho "$1" >> "$0.log"\necho password=fixture-only\n', { mode: 0o700 });
    await symlink(f.project, f.legacy);
    await writeFile(join(f.project, 'credentials'), '');
    await symlink(join(f.project, 'credentials'), join(f.home, '.git-credentials'));
    await writeFile(
      f.global,
      `[http]
followRedirects = ${redirects}
[credential]
helper = cache
helper = store
[credential "fixture.invalid"]
helper = ${inaccessible}
[credential "https://*.invalid/selected"]
helper =
helper = ${first}
[credential "https://fixture.invalid/selected"]
helper = ${second}
`,
    );
    const env = await f.capture();
    await expect(stat(first + '.log')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.credential(env, 'fill')).toBe(0);
    expect(await readFile(first + '.log', 'utf8')).toBe('get\n');
    expect(await readFile(second + '.log', 'utf8')).toBe('get\n');
    const activeLease = f.checks.mock.calls.at(-1)![0];
    expect(activeLease).not.toContain(inaccessible);
    expect(activeLease).not.toContain(join(f.legacy, 'socket'));
    expect(activeLease).not.toContain(join(f.home, '.git-credentials'));
    // An unavailable cache or store cannot release credentials to a redirected host.
    expect(await f.credential(env, 'fill', 'https://other.invalid/package')).not.toBe(0);
  },
);

it.skipIf(process.platform === 'win32').each(['cache', 'store', 'executable'])(
  'fails before transport when the selected URL requires an unavailable %s',
  async kind => {
    const f = await credentialCacheFixture();
    const helper = kind === 'executable' ? join(f.project, 'helper') : kind;
    await symlink(f.project, f.legacy);
    await writeFile(join(f.project, 'credentials'), '');
    await symlink(join(f.project, 'credentials'), join(f.home, '.git-credentials'));
    await writeFile(f.global, `[credential "https://fixture.invalid"]\nhelper = ${helper}\n`);
    await expect(f.capture()).rejects.toThrow('outside writable workspaces');
  },
);

it.skipIf(process.platform === 'win32').each(['false', 'initial', 'true'])(
  'keeps the downstream cache in its own credential context with followRedirects=%s',
  async redirects => {
    const f = await credentialCacheFixture();
    const directory = join(f.configured, 'git/credential');
    const daemon = await fixtureCacheDaemon(directory);
    onTestFinished(daemon.close);
    await writeFile(
      f.global,
      `[http "https://fixture.invalid"]\nfollowRedirects = ${redirects}\n[credential "https://downstream.invalid"]\nhelper = cache\n`,
    );
    const env = await f.capture();
    f.checks.mockClear();
    expect(await f.credential(env, 'reject')).toBe(0);
    expect(daemon.actions).toEqual([]);
    expect(f.checks.mock.calls.flatMap(([paths]) => paths)).not.toContain(join(directory, 'socket'));
    expect(await f.credential(env, 'reject', 'https://downstream.invalid/repository')).toBe(0);
    expect(daemon.actions).toEqual(['action=erase']);
    expect(f.checks.mock.calls.flatMap(([paths]) => paths)).toContain(join(directory, 'socket'));
  },
);

it.skipIf(process.platform === 'win32').each(['global', 'host-scoped'])(
  'applies a %s username before a partial username-qualified helper reset',
  async kind => {
    const f = await credentialCacheFixture();
    const helper = join(f.home, 'account-helper');
    await writeFile(helper, '#!/bin/sh\necho "$1" >> "$0.log"\necho password=fixture-only\n', { mode: 0o700 });
    const username = kind === 'global' ? '[credential]' : '[credential "https://fixture.invalid"]';
    await symlink(f.project, f.legacy);
    await writeFile(
      f.global,
      `[http]\nfollowRedirects = false\n[credential]\nhelper = cache\n${username}\nusername = alice\n[credential "alice@fixture.invalid/selected"]\nhelper =\nhelper = ${helper}\n`,
    );
    const env = await f.capture();
    expect(await f.credential(env, 'fill')).toBe(0);
    expect(await readFile(helper + '.log', 'utf8')).toBe('get\n');
    expect(f.checks.mock.calls.at(-1)![0]).toContain(helper);
  },
);
it.skipIf(process.platform === 'win32').each(['http://proxy.invalid', 'cert:///'])(
  'admits the cache socket when Git requests secondary credentials for %s',
  async scope => {
    const f = await credentialCacheFixture();
    const directory = join(f.configured, 'git/credential');
    const daemon = await fixtureCacheDaemon(directory);
    onTestFinished(daemon.close);
    await writeFile(f.global, `[http]\nfollowRedirects = off\n[credential "${scope}"]\nhelper = cache\n`);
    const env = await f.capture();
    f.checks.mockClear();
    expect(await f.credential(env, 'reject', scope + '/fixture')).toBe(0);
    expect(daemon.actions).toEqual(['action=erase']);
    expect(f.checks.mock.calls.flatMap(([paths]) => paths)).toContain(join(directory, 'socket'));
  },
);

it.skipIf(process.platform === 'win32')('rechecks a secondary cache endpoint when Git first requests it', async () => {
  const f = await credentialCacheFixture();
  const directory = join(f.configured, 'git/credential');
  const daemon = await fixtureCacheDaemon(directory);
  onTestFinished(daemon.close);
  await writeFile(f.global, '[credential "https://downstream.invalid"]\nhelper = cache\n');
  const env = await f.capture();
  await f.attach(directory);
  expect(await f.credential(env, 'reject')).toBe(0);
  await expect(f.credential(env, 'reject', 'https://downstream.invalid/repository')).rejects.toThrow();
  expect(daemon.actions).toEqual([]);
});

it.skipIf(process.platform === 'win32')('admits each member of a secondary helper chain in Git order', async () => {
  const f = await credentialCacheFixture();
  const first = join(f.home, 'username'),
    second = join(f.home, 'password');
  await writeFile(first, '#!/bin/sh\necho "$1" >> "$0.log"\necho username=fixture\n', { mode: 0o700 });
  await writeFile(second, '#!/bin/sh\necho "$1" >> "$0.log"\necho password=fixture-only\n', { mode: 0o700 });
  await writeFile(f.global, `[credential "https://downstream.invalid"]\nhelper = ${first}\nhelper = ${second}\n`);
  const env = await f.capture();
  f.checks.mockClear();
  expect(await f.credential(env, 'fill', 'https://downstream.invalid/package')).toBe(0);
  expect(await readFile(first + '.log', 'utf8')).toBe('get\n');
  expect(await readFile(second + '.log', 'utf8')).toBe('get\n');
  const checked = f.checks.mock.calls.flatMap(([paths]) => paths);
  expect(checked.indexOf(first)).toBeGreaterThanOrEqual(0);
  expect(checked.indexOf(second)).toBeGreaterThan(checked.indexOf(first));
});

it.skipIf(process.platform === 'win32')(
  'keeps a secondary helper inert when the caller has no process lease for it',
  async () => {
    const f = await credentialCacheFixture();
    const helper = join(f.home, 'standalone-helper');
    await writeFile(helper, '#!/bin/sh\necho "$1" >> "$0.log"\necho username=fixture\necho password=fixture-only\n', {
      mode: 0o700,
    });
    await writeFile(f.global, `[credential "https://downstream.invalid"]\nhelper = ${helper}\n`);
    const env = await captureRepositoryEnvironment(
      [f.project],
      f.preview,
      new AbortController().signal,
      testFilesystemMetadata,
      'source.git',
      undefined,
      vi.fn(),
    );
    expect(await f.credential(env, 'fill', 'https://downstream.invalid/package')).not.toBe(0);
    await expect(readFile(helper + '.log')).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
