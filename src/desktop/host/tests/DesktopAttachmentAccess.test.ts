import { WorkspaceDisclosure } from '#src/workspace/WorkspaceDisclosure.js';
import { WorkspaceRootSelections } from '#src/workspace/WorkspaceRootSelections.js';
import { Deferred } from '#src/shared/Deferred.js';
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';
import { WorkspaceContentAccess } from '#src/workspace/policy/WorkspaceContentAccess.js';
import { WorkspaceRootAccess } from '#src/workspace/policy/WorkspaceRootAccess.js';
import { StartupUserProfile } from '#src/workspace/policy/StartupUserProfile.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { GlyphContextAttachmentKind as Kind } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { formatFolderAttachment } from '#src/desktop/workbench/formatFolderContextOutline.js';
import { DesktopAttachmentAccess } from '../DesktopAttachmentAccess.ts';

describe(DesktopAttachmentAccess, () => {
  it('checks dirty selections, Git comparisons and folder outlines against live native policy', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-desktop-attach-')));
    const visible = 'src/notes.md';
    const hidden = 'personal/rules/style.md';
    const state = 'host/state.json';
    const privatePaths = [join(root, state)];
    const profile = new StartupUserProfile(join(root, 'personal'));
    const policy = new WorkspaceContentAccess(profile, () => privatePaths, []);
    const binaryPath = resolve('target/release/glyph-context-index');
    const physicalAccess = new NativeFilesystemMetadata(binaryPath);
    const bound = new WorkspaceRootAccess(policy.project, root, true);
    const index = new RustWorkspacePathIndex({ access: bound, binaryPath });
    onTestFinished(async () => {
      await index.dispose();
      profile.dispose();
      await rm(root, { recursive: true, force: true });
    });
    for (const name of [visible, hidden, state]) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), 'disk revision');
    }
    const project = new FileSystemWorkspaceTextStore(root, { access: bound, physicalAccess });
    const selected = new FileSystemWorkspaceTextStore(root, {
      access: new WorkspaceRootAccess(policy.selectedFile, root, true),
      physicalAccess,
    });
    const routes = new WorkspaceSourceRoutes([{ name: 'work', path: root }]);
    const access = new DesktopAttachmentAccess(
      routes,
      [{ name: 'work', disk: project, selectedDisk: selected, index }],
      () => policy.project.beginOperation().assertCurrent,
    );
    const signal = new AbortController().signal;
    const resource = (path: string, folder = false) => ({ path, uri: pathToFileURL(join(root, path)).href, folder });
    const frozen = {
      kind: Kind.SELECTION,
      ...resource(visible),
      text: 'unsaved selection',
      contentRevision: 'editor-7',
    };
    const diskRead = vi.spyOn(selected, 'read');
    await writeFile(join(root, visible), 'later disk revision');
    await expect(access.admit([frozen], signal)).resolves.toBeUndefined();
    await expect(access.admit([{ ...frozen, uri: visible }], signal)).resolves.toBeUndefined();
    expect(diskRead).not.toHaveBeenCalled();
    await expect(access.admit([{ ...frozen, uri: resource(state).uri }], signal)).rejects.toThrow(
      'declared workspace path',
    );
    await expect(access.admit([{ ...frozen, ...resource(state) }], signal)).rejects.toThrow();
    await expect(access.admit([{ ...frozen, ...resource(hidden) }], signal)).resolves.toBeUndefined();
    await expect(access.admit([{ ...frozen, ...resource(hidden), kind: Kind.SYMBOL }], signal)).rejects.toThrow();
    const alias = 'alias.json';
    await link(join(root, state), join(root, alias));
    await expect(access.admit([{ ...frozen, ...resource(alias) }], signal)).rejects.toThrow('hard links');
    await rm(join(root, alias));
    const git = new URL(resource(state).uri);
    const before =
      'git:' + git.pathname + '?' + encodeURIComponent(JSON.stringify({ path: join(root, state), ref: 'HEAD' }));
    await expect(
      access.admit(
        [
          {
            ...frozen,
            kind: Kind.DIFF,
            text: 'Git diff: staged\nBase URI: ' + before + '\nTarget URI: ' + frozen.uri + '\n',
          },
        ],
        signal,
      ),
    ).rejects.toThrow();
    const folder = resource('.', true);
    const listing = await access.resolve(folder, signal);
    expect(listing).toEqual({ files: [visible], truncated: false });
    await expect(access.resolve(resource('src', true), signal)).resolves.toEqual({
      files: ['notes.md'],
      truncated: false,
    });
    await expect(access.resolve(resource('personal/rules', true), signal)).rejects.toThrow();
    const outline = { ...frozen, ...folder, kind: Kind.FOLDER, text: formatFolderAttachment('.', [visible], false) };
    const disclosure = new WorkspaceDisclosure();
    await access.admit([outline, { ...outline, folderListing: listing! }], signal, disclosure);
    (await disclosure.authorize(signal))();
    await expect(
      access.admit([{ ...outline, text: formatFolderAttachment('.', [state], false) }], signal),
    ).rejects.toThrow('folder contents');
    for (const folderListing of [
      { files: Array.from({ length: 1001 }, () => visible), truncated: false },
      { files: [visible], truncated: 'no' as unknown as boolean },
    ])
      await expect(access.admit([{ ...outline, folderListing }], signal)).rejects.toThrow('folder contents');
    await writeFile(join(root, 'later.md'), 'other');
    await index.refresh();
    await expect(access.admit([outline], signal)).resolves.toBeUndefined();
    privatePaths.push(join(root, visible));
    await expect(disclosure.authorize(signal)).rejects.toThrow('Workspace access changed');
    await expect(access.admit([{ ...outline, folderListing: listing! }], signal)).rejects.toThrow('folder contents');
    await expect(access.admit([frozen], signal)).rejects.toThrow();
  });

  it('accepts typed virtual captures and rejects unavailable or unbound sources before resolving their contents', async () => {
    const access = new DesktopAttachmentAccess(new WorkspaceSourceRoutes([]), [], () => () => {});
    const signal = new AbortController().signal;
    const base = {
      kind: Kind.FILE,
      path: 'capture',
      uri: 'untitled:Untitled-1',
      text: 'frozen',
      contentRevision: 'v1',
    };
    for (const [kind, uri] of [
      [Kind.SELECTION, base.uri],
      [Kind.TEST, 'glyph-test:run'],
      [Kind.TEST, 'vscode-test-data://run'],
      [Kind.TERMINAL, 'glyph-terminal:selection'],
    ] as const)
      await expect(access.admit([{ ...base, kind, uri }], signal)).resolves.toBeUndefined();
    for (const capture of [
      { ...base, unavailable: 'removed' },
      { ...base, kind: Kind.FOLDER },
      { ...base, uri: 'git:unbound' },
      { ...base, uri: 'capture' },
      { ...base, kind: Kind.RULE, uri: 'file:///workspace/rule' },
      { ...base, kind: Kind.SKILL, uri: 'file:///workspace/skill' },
      { ...base, folderListing: { files: [], truncated: false } },
    ])
      await expect(access.admit([capture], signal)).rejects.toThrow('Unsupported attachment source');
    await expect(
      access.resolve({ uri: 'file:///workspace/a', path: 'missing/a', folder: false }, signal),
    ).rejects.toThrow('workspace folder is unavailable');
  });

  it('binds root-qualified captures to the selected alias and excludes siblings from root folder listings', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'glyph-attach-alias-')));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const actual = join(base, 'actual'),
      alias = join(base, 'alias'),
      other = join(base, 'other');
    await mkdir(actual);
    await mkdir(other);
    await symlink(actual, alias);
    const routes = new WorkspaceSourceRoutes([
      { name: 'one', path: actual, uri: pathToFileURL(alias).href },
      { name: 'two', path: other },
    ]);
    const binding = WorkspaceRootAccess.forMetadataProbe(actual);
    const owner = {
      beginOperation: () => binding.beginOperation(),
      validateAccess: vi.fn(async () => {}),
      inspectDirectory: vi.fn(async () => ({ root: actual, searchRoot: actual })),
    };
    const first = { glob: vi.fn(async () => ({ files: ['notes.md'], truncated: false })) };
    const second = { glob: vi.fn(async () => ({ files: ['other.md'], truncated: false })) };
    const signal = new AbortController().signal;
    const access = new DesktopAttachmentAccess(
      routes,
      [
        { name: 'one', selectedDisk: owner, disk: owner, index: first },
        { name: 'two', selectedDisk: owner, disk: owner, index: second },
      ],
      () => () => {},
    );
    await expect(
      access.resolve({ path: 'one', uri: pathToFileURL(alias).href, folder: true }, signal),
    ).resolves.toEqual({ files: ['notes.md'], truncated: false });
    expect(second.glob).not.toHaveBeenCalled();
    const file = { path: 'one/notes.md', uri: pathToFileURL(join(alias, 'notes.md')).href, folder: false };
    await expect(access.resolve(file, signal)).resolves.toBeUndefined();
    await expect(access.resolve({ ...file, path: 'two/notes.md' }, signal)).rejects.toThrow('declared workspace path');
    const review = (before: string) => ({
      ...file,
      kind: Kind.DIFF,
      projectFile: true as const,
      contentRevision: 'v1',
      text: 'Git diff: renamed\nBase URI: ' + before + '\nTarget URI: /dev/null\n',
    });
    await expect(access.admit([{ ...review(file.uri), text: 'Review snapshot' }], signal)).resolves.toBeUndefined();
    const history = (path: string, submoduleOf?: string) =>
      'git:/old?' + encodeURIComponent(JSON.stringify({ path, submoduleOf, ref: 'HEAD' }));
    const disclosure = new WorkspaceDisclosure();
    await access.admit([review(history(join(other, 'child', 'old.md'), other))], signal, disclosure);
    expect([...disclosure.additionalPaths]).toEqual(['two/child/old.md']);
    (await disclosure.authorize(signal))();
    owner.validateAccess.mockRejectedValueOnce(new Error('The comparison resource is unavailable.'));
    await expect(disclosure.authorize(signal)).rejects.toThrow('comparison resource');
    expect(owner.validateAccess).toHaveBeenCalledWith('child/old.md');
    for (const source of [
      'https://example.test/file',
      history('relative.md'),
      history(join(other, 'child.md'), actual),
      history(join(other, 'child.md'), 'relative'),
      history(join(other, 'child.md'), join(other, 'deep')),
      pathToFileURL(base).href,
    ])
      await expect(access.admit([review(source)], signal)).rejects.toThrow();
    await rm(alias);
    await symlink(other, alias);
    await expect(access.resolve(file, signal)).rejects.toThrow('changed its workspace location');
  });

  it.each([false, true])(
    'retains each selected root through batch delivery, including Git sides (diff %s)',
    async diff => {
      const base = await realpath(await mkdtemp(join(tmpdir(), 'glyph-attachment-delivery-')));
      const selections = new WorkspaceRootSelections();
      const profile = new StartupUserProfile(join(base, 'profile'));
      const policies = new WorkspaceContentAccess(profile, () => [], []);
      onTestFinished(async () => {
        selections[Symbol.dispose]();
        profile.dispose();
        await rm(base, { recursive: true, force: true });
      });
      const physicalAccess = new NativeFilesystemMetadata(resolve('target/release/glyph-context-index'));
      const roots = await Promise.all(
        ['first', 'second'].map(async name => {
          const path = join(base, name);
          await mkdir(path);
          await writeFile(join(path, 'notes.md'), name);
          await writeFile(join(path, 'slow.md'), name);
          const selection = selections.select(path);
          const store = (policy: typeof policies.project) =>
            new FileSystemWorkspaceTextStore(path, {
              access: new WorkspaceRootAccess(policy, path, true, [], selection.assertCurrent),
              physicalAccess,
            });
          return {
            name,
            path,
            disk: store(policies.project),
            selectedDisk: store(policies.selectedFile),
            index: { glob: vi.fn() },
          };
        }),
      );
      const routes = new WorkspaceSourceRoutes(roots);
      const access = new DesktopAttachmentAccess(routes, roots, () => policies.project.beginOperation().assertCurrent);
      const first = {
        kind: Kind.FILE,
        uri: pathToFileURL(join(base, 'first/notes.md')).href,
        path: 'first/notes.md',
        text: 'first',
        contentRevision: '1',
      };
      const second = { ...first, path: 'second/notes.md', uri: pathToFileURL(join(base, 'second/notes.md')).href };
      const slow = { ...first, path: 'second/slow.md', uri: pathToFileURL(join(base, 'second/slow.md')).href };
      const signal = new AbortController().signal;
      const firstRead = roots[0]!.selectedDisk.validateAccess.bind(roots[0]!.selectedDisk);
      const firstDone = new Deferred<void>();
      vi.spyOn(roots[0]!.selectedDisk, 'validateAccess').mockImplementation(async path => {
        await firstRead(path);
        firstDone.resolve();
      });
      const secondRead = roots[1]!.selectedDisk.validateAccess.bind(roots[1]!.selectedDisk);
      const entered = new Deferred<void>();
      const release = new Deferred<void>();
      vi.spyOn(roots[1]!.selectedDisk, 'validateAccess').mockImplementation(async path => {
        if (path === 'slow.md') {
          entered.resolve();
          await release.promise;
        }
        await secondRead(path);
      });
      const attachments = diff
        ? [
            {
              ...second,
              kind: Kind.DIFF,
              text: 'Git diff: staged\nBase URI: ' + first.uri + '\nTarget URI: ' + slow.uri + '\n',
            },
          ]
        : [first, slow];
      const result = access.admit(attachments, signal);
      await Promise.all([firstDone.promise, entered.promise]);
      await rename(join(base, 'first'), join(base, 'original'));
      await mkdir(join(base, 'first'));
      await writeFile(join(base, 'first/notes.md'), 'replacement');
      release.resolve();
      await expect(result).rejects.toThrow('selected workspace folder changed');
      await expect(access.admit([second], signal)).resolves.toBeUndefined();
    },
  );
});
