import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import { chmod, mkdir, mkdtemp, writeFile, readFile, rm, symlink, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { it, expect, vi, onTestFinished } from 'vitest';
import { HostProcessLeases } from '#src/shell/HostProcessLeases.js';
import { SkillRepositoryGit } from '#src/skills/SkillRepositoryGit.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'glyph-git-budget-'));
  const config = join(directory, 'trusted.config');
  await writeFile(config, '');
  vi.stubEnv('HOME', directory);
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
it('rechecks frozen configuration authority when a peer attaches its dotfiles checkout', async () => {
  const root = await fixture();
  const preview = join(root, 'preview');
  const dotfiles = join(root, 'dotfiles');
  await mkdir(preview);
  await mkdir(dotfiles);
  const config = join(dotfiles, 'git.config');
  await writeFile(config, '[user]\nname = Host identity\n');
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  let roots: string[] = [];
  const transport = new SkillRepositoryGit(preview, new AbortController().signal, () => roots, testFilesystemMetadata);
  expect((await transport.run(['--version'])).toString()).toContain('git version');
  roots = [dotfiles];
  await expect(transport.run(['--version'])).rejects.toThrow('outside writable workspaces');
});
it.each(['file URL', 'absolute path', 'Git suffix'])(
  'leases the effective %s mirror for fetch and later object reads',
  async form => {
    const base = await fixture();
    const preview = join(base, 'preview');
    const mirror = join(base, 'local mirror.git');
    await mkdir(preview);
    execFileSync('git', ['init', '--bare', '--quiet', '--template=', mirror]);
    const url = 'https://example.invalid/selected.git';
    const source =
      form === 'Git suffix'
        ? pathToFileURL(mirror.slice(0, -4)).href
        : form === 'file URL'
          ? pathToFileURL(mirror).href
          : mirror;
    await writeFile(join(base, 'trusted.config'), `[url "${source}"]\ninsteadOf = ${url}\n`);
    let roots: string[] = [];
    const leases = new HostProcessLeases(() => roots);
    const transport = new SkillRepositoryGit(preview, new AbortController().signal, leases, testFilesystemMetadata);
    await transport.initialize(url);
    const list = () => transport.run(['--git-dir=source.git', 'ls-remote', 'origin']);
    expect(await list()).toEqual(Buffer.alloc(0));
    await leases.admitWorkspace(
      () => [mirror],
      attached => {
        roots = [...attached];
      },
    );
    await expect(transport.run(['--git-dir=source.git', 'cat-file', '--batch-check'])).rejects.toThrow(
      'outside writable workspaces',
    );
    await expect(list()).rejects.toThrow('outside writable workspaces');
    roots = [];
    expect(await list()).toEqual(Buffer.alloc(0));
  },
);

it.each([
  'checkout',
  'gitfile',
  'common',
  'alternate',
  'late alternate',
  'nested object link',
  'config include',
  'not a repository',
  'empty directory',
  'invalid refs',
] as const)('checks the %s repository layout before local transport or subsequent object reads', async layout => {
  const base = await fixture();
  const preview = join(base, 'preview');
  const mirror = join(base, 'mirror');
  await mkdir(preview);
  execFileSync('git', ['init', '--quiet', '--template=', mirror]);
  const gitDir = join(mirror, '.git');
  const url = 'https://example.invalid/selected.git';
  await writeFile(join(base, 'trusted.config'), `[url "${pathToFileURL(mirror).href}"]\ninsteadOf = ${url}\n`);
  const transport = new SkillRepositoryGit(preview, new AbortController().signal, [], testFilesystemMetadata);
  await transport.initialize(url);
  const list = () => transport.run(['--git-dir=source.git', 'ls-remote', 'origin']);
  await writeFile(join(gitDir, 'objects/info/packs'), '');
  if (layout === 'checkout' || layout === 'late alternate') {
    expect(await list()).toEqual(Buffer.alloc(0));
    if (layout === 'checkout') return;
  }
  if (layout === 'not a repository') {
    await rm(mirror, { recursive: true });
    await writeFile(mirror, 'not a directory');
    await expect(list()).rejects.toThrow('self-contained repository');
  } else if (layout === 'empty directory') {
    await rm(gitDir, { recursive: true });
    await expect(list()).rejects.toThrow('does not contain a repository');
  } else if (layout === 'invalid refs') {
    await rm(join(gitDir, 'refs'), { recursive: true });
    await writeFile(join(gitDir, 'refs'), 'not a directory');
    await expect(list()).rejects.toThrow('ordinary object and reference directories');
  } else if (layout === 'nested object link') {
    const shard = join(gitDir, 'objects', '11');
    await mkdir(shard);
    await symlink('../other-object', join(shard, 'object'));
    await expect(list()).rejects.toThrow('self-contained object');
  } else if (layout === 'config include') {
    await writeFile(join(gitDir, 'config.worktree'), '[include]\npath = ../other.config\n');
    await expect(list()).rejects.toThrow('configuration includes');
  } else if (layout === 'gitfile') {
    await rm(gitDir, { recursive: true });
    await writeFile(gitDir, 'gitdir: ../administrative-area\n');
    await expect(list()).rejects.toThrow('Linked worktrees');
  } else {
    const marker = layout === 'common' ? 'commondir' : 'objects/info/alternates';
    await writeFile(join(gitDir, marker), '../other-directory\n');
    await expect(list()).rejects.toThrow('common directory or alternate object store');
  }
});

it.each([
  '/mirror/../other',
  'file:///mirror\tother',
  '../mirror.git',
  'file://server/mirror.git',
  'file:///~/mirror.git',
  'file:///one/%2E%2E/mirror.git',
])('requires an unambiguous absolute path before opening a local mirror at %s', async source => {
  const root = await fixture();
  await writeFile(
    join(root, 'trusted.config'),
    `[url "${source}"]\ninsteadOf = https://example.invalid/selected.git\n`,
  );
  const git = new SkillRepositoryGit(root, new AbortController().signal, [], testFilesystemMetadata);
  await git.initialize('https://example.invalid/selected.git');
  await expect(git.run(['--git-dir=source.git', 'ls-remote', 'origin'])).rejects.toThrow('absolute repository path');
});

it('propagates a filesystem inspection failure before opening an unavailable mirror', async () => {
  const base = await fixture();
  const url = 'https://example.invalid/oversized.git';
  const mirror = join(base, 'x'.repeat(16384));
  await writeFile(join(base, 'trusted.config'), `[url "${mirror}"]\ninsteadOf = ${url}\n`);
  const transport = new SkillRepositoryGit(base, new AbortController().signal, [], testFilesystemMetadata);
  await transport.initialize(url);
  await expect(transport.run(['--git-dir=source.git', 'ls-remote', 'origin'])).rejects.toMatchObject({
    code: 'ENAMETOOLONG',
  });
});

it('rejects a repository object store over budget before starting another object fetch', async () => {
  const root = await fixture();
  await writeFile(join(root, 'objects.pack'), Buffer.alloc(32 * 1024 * 1024 + 1));
  await expect(
    new SkillRepositoryGit(root, new AbortController().signal, [], testFilesystemMetadata).run(['version']),
  ).rejects.toThrow('32 MiB');
});
it.skipIf(process.platform === 'win32')(
  'terminates Git transport helpers and settles cancellation before returning',
  async () => {
    const root = await fixture();
    const cancel = new AbortController();
    const result = new SkillRepositoryGit(root, cancel.signal, [], testFilesystemMetadata).run([
      '-c',
      'alias.wait-for-cancel=!sleep 30 & echo $! > helper-pid; wait',
      'wait-for-cancel',
    ]);
    let helper = 0;
    await vi.waitFor(async () => {
      helper = Number(await readFile(join(root, 'helper-pid'), 'utf8'));
      expect(helper).toBeGreaterThan(0);
    });
    cancel.abort(new Error('Read cancelled'));
    await expect(result).rejects.toThrow('Read cancelled');
    await vi.waitFor(() => {
      expect(() => process.kill(helper, 0)).toThrow();
    });
  },
);
it.skipIf(process.platform === 'win32').each(['credential helper', 'credential cache', 'mirror'])(
  'holds the configured %s through transport close and releases it for the next preview',
  async input => {
    const base = await fixture();
    const cwd = join(base, 'preview');
    const helpers = join(base, 'helpers');
    await Promise.all([mkdir(cwd), mkdir(helpers)]);
    const helper = join(helpers, 'fixture-helper');
    await writeFile(helper, '#!/bin/sh\nexit 0\n');
    await chmod(helper, 0o700);
    const url = 'https://example.invalid/selected.git';
    if (input === 'mirror') execFileSync('git', ['init', '--bare', '--quiet', '--template=', helpers]);
    vi.stubEnv('XDG_CACHE_HOME', helpers);
    const configuration =
      input === 'mirror'
        ? `[url "${pathToFileURL(helpers).href}"]\ninsteadOf = ${url}\n`
        : '[credential]\nhelper = ' + (input === 'credential cache' ? 'cache' : helper) + '\n';
    await writeFile(join(base, 'trusted.config'), configuration);
    let roots: string[] = [];
    const leases = new HostProcessLeases(() => roots);
    const cancel = new AbortController();
    onTestFinished(() => {
      cancel.abort();
    });
    const transport = new SkillRepositoryGit(cwd, cancel.signal, leases, testFilesystemMetadata);
    await transport.initialize(url);
    const running = transport.run([
      '-c',
      'alias.wait-for-peer=!sleep 30 & echo $! > helper-pid; wait',
      'wait-for-peer',
    ]);
    const rejected = expect(running).rejects.toThrow('workspace is attaching');
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(join(cwd, 'helper-pid'), 'utf8'));
      expect(pid).toBeGreaterThan(0);
    });
    await leases.admitWorkspace(
      () => [helpers],
      () => {
        roots = [helpers];
      },
    );
    await rejected;
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
    await expect(transport.run(['--version'])).rejects.toThrow('outside writable workspaces');
    roots = [];
    expect((await transport.run(['--version'])).toString()).toContain('git version');
  },
);
it('bounds each Git object read and propagates missing-command diagnostics', async () => {
  const root = await fixture();
  const git = new SkillRepositoryGit(root, new AbortController().signal, [], testFilesystemMetadata);
  await expect(git.run(['--version'], 2)).rejects.toThrow('output budget');
  await expect(git.run(['missing-glyph-test-subcommand'])).rejects.toThrow('missing-glyph-test-subcommand');
});

it('evaluates conditional includes against the initialized bare store before using any repository transport', async () => {
  const root = await fixture();
  const included = join(root, 'conditional.config');
  await writeFile(included, '[user]\nname = Conditional trusted identity\n');
  await writeFile(join(root, 'trusted.config'), '[includeIf "gitdir:**/source.git"]\npath = conditional.config\n');
  const git = new SkillRepositoryGit(root, new AbortController().signal, [], testFilesystemMetadata);
  await git.initialize('https://example.invalid/selected.git');
  expect((await git.run(['--git-dir=source.git', 'config', '--get', 'user.name'])).toString()).toBe(
    'Conditional trusted identity\n',
  );
  await writeFile(included, '[user]\nname = Later changed value\n');
  expect((await git.run(['--git-dir=source.git', 'config', '--get', 'user.name'])).toString()).toBe(
    'Conditional trusted identity\n',
  );
});

it('freezes URL-selected settings after recording the remote and before using transport', async () => {
  const root = await fixture();
  const included = join(root, 'company.config');
  await writeFile(included, '[user]\nname = Selected remote identity\n');
  await writeFile(
    join(root, 'trusted.config'),
    '[includeIf "hasconfig:remote.*.url:https://example.invalid/**"]\npath = company.config\n' +
      '[remote "origin"]\nURL = https://other.invalid/default.git\npushURL = https://other.invalid/push.git\n' +
      '[remote "other"]\nurl = file:///unselected\npromisor = true\npartialCloneFilter = blob:none\n' +
      '[extensions]\npartialClone = other\n',
  );
  const git = new SkillRepositoryGit(root, new AbortController().signal, [], testFilesystemMetadata);
  await git.initialize('https://example.invalid/selected.git');
  expect((await git.run(['--git-dir=source.git', 'config', '--get-all', 'remote.origin.url'])).toString()).toBe(
    'https://example.invalid/selected.git\n',
  );
  await expect(
    git.run([
      '--git-dir=source.git',
      'config',
      '--get-regexp',
      '^(remote\\.other\\.(url|promisor|partialclonefilter)|remote\\.origin\\.pushurl|extensions\\.partialclone)$',
    ]),
  ).rejects.toThrow('Git repository access failed');
  const name = () => git.run(['--git-dir=source.git', 'config', '--get', 'user.name']);
  expect((await name()).toString().trim()).toBe('Selected remote identity');
  await writeFile(included, '[user]\nname = Changed after capture\n');
  expect((await name()).toString().trim()).toBe('Selected remote identity');
});

it('pins a primary checkout as the transport source while a peer owns its distinct bare sibling', async () => {
  const base = await fixture();
  const preview = join(base, 'preview');
  const checkout = join(base, 'skills');
  const sibling = checkout + '.git';
  await mkdir(preview);
  execFileSync('git', ['init', '--quiet', '--template=', checkout]);
  execFileSync('git', ['init', '--bare', '--quiet', '--template=', sibling]);
  const url = 'https://example.invalid/primary.git';
  await writeFile(
    join(base, 'trusted.config'),
    [
      `[url "${pathToFileURL(checkout).href}"]`,
      `insteadOf = ${url}`,
      `[url "${pathToFileURL(sibling).href}"]`,
      `pushInsteadOf = ${url}`,
      '[user]',
      'name = Trusted identity',
    ].join('\n'),
  );
  const transport = new SkillRepositoryGit(preview, new AbortController().signal, [sibling], testFilesystemMetadata);
  await transport.initialize(url);
  const run = (...args: string[]) => transport.run(['--git-dir=source.git', ...args]);
  expect(await run('ls-remote', 'origin')).toEqual(Buffer.alloc(0));
  const selected = await realpath(join(checkout, '.git'));
  expect((await run('remote', 'get-url', 'origin')).toString().trim()).toBe(pathToFileURL(selected).href);
  expect((await run('remote', 'get-url', '--push', 'origin')).toString().trim()).toBe(pathToFileURL(selected).href);
  expect((await run('config', '--get', 'user.name')).toString().trim()).toBe('Trusted identity');
  const uploadPack = (await run('config', '--get', 'remote.origin.uploadpack')).toString().trim();
  expect(uploadPack).toContain('GIT_IMPLICIT_WORK_TREE=0 GIT_INDEX_FILE=');
  expect(uploadPack).toContain('glyph-pack.index');
  expect(uploadPack).toMatch(/-c core\.bare=true upload-pack --strict$/u);
  await rename(selected, join(base, 'moved'));
  await expect(run('ls-remote', 'origin')).rejects.toThrow('selected Git mirror is no longer available');
});

it.each(['repository', 'XDG', 'configured', 'home-relative'])(
  'checks the %s attribute source again on later mirror reads',
  async source => {
    const base = await fixture();
    const preview = join(base, 'preview');
    const mirror = join(base, 'mirror.git');
    await mkdir(preview);
    execFileSync('git', ['init', '--bare', '--quiet', '--template=', mirror]);
    const url = 'https://fixture.invalid/repo';
    await writeFile(join(base, 'trusted.config'), `[url "${pathToFileURL(mirror).href}"]\ninsteadOf = ${url}\n`);
    const xdg = join(base, 'xdg');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    const attr =
      source === 'repository'
        ? join(mirror, 'info/attributes')
        : source === 'XDG'
          ? join(xdg, 'git/attributes')
          : join(base, 'attributes');
    if (source === 'configured' || source === 'home-relative')
      execFileSync('git', [
        '--git-dir=' + mirror,
        'config',
        'core.attributesFile',
        source === 'configured' ? attr : '~/attributes',
      ]);
    let roots: string[] = [];
    const transport = new SkillRepositoryGit(
      preview,
      new AbortController().signal,
      () => roots,
      testFilesystemMetadata,
    );
    await transport.initialize(url);
    expect(await transport.run(['--git-dir=source.git', 'ls-remote', 'origin'])).toEqual(Buffer.alloc(0));
    roots = [attr];
    await expect(transport.run(['--git-dir=source.git', 'rev-parse', '--is-bare-repository'])).rejects.toThrow(
      'outside writable workspaces',
    );
  },
);

it.each(['attributesFile', 'worktree'])('requires self-contained %s settings for a local mirror', async setting => {
  const base = await fixture();
  const preview = join(base, 'preview');
  const mirror = join(base, 'mirror.git');
  await mkdir(preview);
  execFileSync('git', ['init', '--bare', '--quiet', '--template=', mirror]);
  execFileSync('git', ['--git-dir=' + mirror, 'config', 'core.' + setting, 'relative/path']);
  const url = 'https://fixture.invalid/repo';
  await writeFile(join(base, 'trusted.config'), `[url "${pathToFileURL(mirror).href}"]\ninsteadOf = ${url}\n`);
  const transport = new SkillRepositoryGit(preview, new AbortController().signal, [], testFilesystemMetadata);
  await transport.initialize(url);
  await expect(transport.run(['--git-dir=source.git', 'ls-remote', 'origin'])).rejects.toThrow(
    setting === 'worktree' ? 'explicit worktree' : 'attributes require an absolute or home-relative path',
  );
});

/** Hold Git at a real loopback connection so a peer attachment occurs while the fetch is live. */
async function heldConnection() {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    const closed = once(server, 'close');
    server.close();
    await closed;
  });
  return { server, host: '127.0.0.1:' + (server.address() as AddressInfo).port };
}

it
  .skipIf(process.platform === 'win32')
  .each([
    'empty HTTP proxy',
    'empty URL-specific proxy',
    'empty named remote proxy',
    'unrelated URL-specific proxy',
    'URL-specific proxy authentication',
    'uppercase proxy authentication',
    'NO_PROXY host',
    'no_proxy CIDR',
    'NO_PROXY wildcard',
    'lowercase precedence',
    'proxy authentication',
    'proxy authentication with a bypass',
  ])('leases a secondary helper only when Git requests it with %s', async mode => {
  const root = await fixture();
  const preview = join(root, 'preview');
  const helperDirectory = join(root, 'account-tools');
  await mkdir(preview);
  await mkdir(helperDirectory);
  const helper = join(helperDirectory, 'provide-credentials');
  await writeFile(helper, '#!/bin/sh\necho "$1" >> "$0.log"\necho username=fixture\necho password=fixture-only\n', {
    mode: 0o700,
  });
  const direct = await heldConnection();
  const proxy = await heldConnection();
  const needsHelper = mode.includes('proxy authentication');
  const proxyUrl = 'http://' + (needsHelper ? 'fixture@' : '') + proxy.host;
  const url = 'https://' + direct.host + '/repository';
  vi.stubEnv('https_proxy', proxyUrl);
  for (const key of ['HTTPS_PROXY', 'NO_PROXY', 'no_proxy']) vi.stubEnv(key, undefined);
  let settings = '[http]\nfollowRedirects = false\n';
  switch (mode) {
    case 'empty HTTP proxy':
      settings += 'proxy =\n';
      break;
    case 'empty URL-specific proxy':
      settings += `[http "${url}"]\nproxy =\n`;
      break;
    case 'empty named remote proxy':
      settings += '[remote "origin"]\nproxy =\n';
      break;
    case 'unrelated URL-specific proxy':
      vi.stubEnv('https_proxy', undefined);
      settings += `[http "https://unrelated.invalid"]\nproxy = ${proxyUrl}\n`;
      break;
    case 'URL-specific proxy authentication':
      vi.stubEnv('https_proxy', undefined);
      settings += `[http "${url}"]\nproxy = ${proxyUrl}\n`;
      break;
    case 'uppercase proxy authentication':
      vi.stubEnv('https_proxy', undefined);
      vi.stubEnv('HTTPS_PROXY', proxyUrl);
      break;
    case 'NO_PROXY wildcard':
      vi.stubEnv('NO_PROXY', '*');
      break;
    case 'no_proxy CIDR':
      vi.stubEnv('no_proxy', '127.0.0.0/8');
      break;
    case 'lowercase precedence':
      vi.stubEnv('NO_PROXY', 'elsewhere.invalid');
      vi.stubEnv('no_proxy', '127.0.0.1');
      break;
    case 'NO_PROXY host':
    case 'proxy authentication with a bypass':
      vi.stubEnv('NO_PROXY', '127.0.0.1');
      break;
  }
  await writeFile(join(root, 'trusted.config'), settings + `[credential "http://${proxy.host}"]\nhelper = ${helper}\n`);
  const leases = new HostProcessLeases([]);
  const cancelled = new AbortController();
  const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(8_000)]);
  const transport = new SkillRepositoryGit(preview, signal, leases, testFilesystemMetadata);
  await transport.initialize(url);
  const server = needsHelper && mode !== 'proxy authentication with a bypass' ? proxy.server : direct.server;
  const connected = once(server, 'connection', { signal });
  const fetch = transport.run(['--git-dir=source.git', 'ls-remote', 'origin']).then(
    () => new Error('Unexpected fetch completion'),
    (error: Error) => error,
  );
  try {
    await Promise.race([
      connected,
      fetch.then(error => {
        throw error;
      }),
    ]);
    const publish = vi.fn();
    await leases.admitWorkspace(() => [helperDirectory], publish);
    expect(publish).toHaveBeenCalledOnce();
    cancelled.abort(new Error('Finished observing the direct transfer'));
    const result = await fetch;
    if (needsHelper) {
      expect(await readFile(helper + '.log', 'utf8')).toBe('get\n');
      expect(result.message).toContain('workspace is attaching');
    } else {
      await expect(readFile(helper + '.log', 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result.message).toContain('Finished observing the direct transfer');
    }
  } finally {
    cancelled.abort();
    await fetch;
  }
});
