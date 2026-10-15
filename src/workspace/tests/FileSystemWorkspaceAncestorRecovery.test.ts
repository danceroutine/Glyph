import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentConfigurationProvider } from '#src/configuration/EnvironmentConfigurationProvider.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import type { ProposalReviewStore } from '#src/editing/reviews/persistence/ProposalReviewStore.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';

const filesystem = vi.hoisted(() => ({
  lstat: vi.fn(),
  stat: vi.fn(),
  realpath: vi.fn(),
  open: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  link: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  ...filesystem,
}));

afterEach(() => vi.resetAllMocks());

describe(FileSystemWorkspaceTextStore, () => {
  it.each([EditOperation.UPDATE, EditOperation.DELETE, EditOperation.CREATE, EditOperation.RENAME])(
    'keeps a pending %s review stale and rejectable when a regular file replaces its parent directory',
    async operation => {
      const fixture = virtualWorkspace();
      const path = operation === EditOperation.RENAME ? 'source.txt' : 'src/file.txt';
      const base = operation === EditOperation.CREATE ? null : await fixture.workspace.read(path);
      const compiler = new EditProposalService(
        fixture.workspace,
        new JsDiffTextDiffer(),
        new EnvironmentConfigurationProvider({}).editing,
      );
      if (operation === EditOperation.CREATE || operation === EditOperation.RENAME) {
        fixture.nodes.delete('/fixture/src/file.txt');
      }
      const proposal = await compiler.proposeStructured({
        files: [
          {
            operation,
            path,
            new_path: operation === EditOperation.RENAME ? 'src/file.txt' : null,
            base_revision: base?.revision ?? null,
            content: operation === EditOperation.CREATE || operation === EditOperation.UPDATE ? 'next' : null,
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      if (operation === EditOperation.DELETE || operation === EditOperation.RENAME) {
        const file = proposal.files[0]!;
        file.applyingItemId = file.items[0]!.id;
        file.applicability = EditApplicabilityState.APPLYING;
      }
      let persisted = structuredClone([proposal]);
      const checkpoint: ProposalReviewStore = {
        load: async () => structuredClone(persisted),
        save: async proposals => {
          persisted = structuredClone([...proposals]);
        },
        clear: async () => {
          persisted = [];
        },
      };
      fixture.nodes.set('/fixture/src', Buffer.from('replacement file'));
      const manager = new ProposalReviewManager(fixture.workspace, checkpoint);

      await expect(manager.initialize()).resolves.toBeUndefined();
      expect(manager.active?.files[0]).toMatchObject({
        applicability: EditApplicabilityState.STALE,
        applyingItemId: null,
        items: [{ decision: EditDecisionState.PENDING }],
      });
      expect(manager.pendingResults).toEqual([]);
      await manager.rejectAll();
      expect(manager.pendingResults[0]?.items[0]?.decision).toBe(EditDecisionState.REJECTED);
      expect(filesystem.writeFile).not.toHaveBeenCalled();
      expect(filesystem.mkdir).not.toHaveBeenCalled();
      expect(filesystem.link).not.toHaveBeenCalled();
      expect(filesystem.unlink).not.toHaveBeenCalled();
    },
  );

  it.each(['readOptional', 'exists', 'validateAccess', 'create', 'replace', 'delete', 'rename'] as const)(
    'rejects an impossible child path during %s without treating it as missing or reaching a mutation',
    async operation => {
      const fixture = virtualWorkspace();
      const base = await fixture.workspace.read('source.txt');
      fixture.nodes.set('/fixture/src', Buffer.from('replacement file'));
      filesystem.open.mockClear();
      const operations = {
        readOptional: () => fixture.workspace.readOptional('src/file.txt'),
        exists: () => fixture.workspace.exists('src/file.txt'),
        validateAccess: () => fixture.workspace.validateAccess('src/file.txt'),
        create: () => fixture.workspace.create('src/file.txt', 'new', false),
        replace: () => fixture.workspace.replace('src/file.txt', base.revision, 'new', false),
        delete: () => fixture.workspace.delete('src/file.txt', base.revision),
        rename: () => fixture.workspace.rename('source.txt', 'src/file.txt', base.revision),
      };
      await expect(operations[operation]()).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
      expect(filesystem.open.mock.calls.every(([, flags]) => typeof flags !== 'string')).toBe(true);
      expect(filesystem.writeFile).not.toHaveBeenCalled();
      expect(filesystem.mkdir).not.toHaveBeenCalled();
      expect(filesystem.link).not.toHaveBeenCalled();
      expect(filesystem.unlink).not.toHaveBeenCalled();
    },
  );

  it.each(['ENOENT', 'EACCES', 'EPERM'])('does not mistake filesystem %s for an unsupported ancestor', async code => {
    const fixture = virtualWorkspace();
    const error = Object.assign(new Error('fixture access failure'), { code });
    filesystem.lstat.mockRejectedValue(error);
    if (code === 'ENOENT') {
      await expect(fixture.workspace.readOptional('missing/file.txt')).resolves.toBeUndefined();
      await expect(fixture.workspace.exists('missing/file.txt')).resolves.toBe(false);
      await expect(fixture.workspace.validateAccess('missing/file.txt')).resolves.toBeUndefined();
      return;
    }
    await expect(fixture.workspace.readOptional('src/file.txt')).rejects.toBe(error);
    await expect(fixture.workspace.exists('src/file.txt')).rejects.toBe(error);
    await expect(fixture.workspace.validateAccess('src/file.txt')).rejects.toBe(error);
  });

  it.each(['metadata inspection', 'canonical lookup', 'descriptor open'] as const)(
    'classifies a parent replaced during %s as unsupported instead of absent',
    async phase => {
      const fixture = virtualWorkspace();
      const error = Object.assign(new Error('fixture parent changed'), { code: 'ENOTDIR' });
      if (phase === 'metadata inspection') filesystem.lstat.mockRejectedValue(error);
      if (phase === 'canonical lookup') filesystem.realpath.mockRejectedValue(error);
      if (phase === 'descriptor open') filesystem.open.mockRejectedValue(error);
      await expect(fixture.workspace.readOptional('src/file.txt')).rejects.toMatchObject({
        reason: EditFailureReason.UNSUPPORTED,
      });
    },
  );

  it.each(['create', 'replace', 'delete', 'rename'] as const)(
    'reports an ancestor replaced immediately before %s as unsupported',
    async operation => {
      const fixture = virtualWorkspace();
      const base = await fixture.workspace.read('source.txt');
      const error = Object.assign(new Error('fixture parent changed'), { code: 'ENOTDIR' });
      if (operation === 'create') filesystem.open.mockRejectedValue(error);
      if (operation === 'replace') {
        filesystem.writeFile.mockRejectedValue(error);
        filesystem.unlink.mockRejectedValue(error);
      }
      if (operation === 'delete') filesystem.unlink.mockRejectedValue(error);
      if (operation === 'rename') filesystem.link.mockRejectedValue(error);
      const operations = {
        create: () => fixture.workspace.create('src/new.txt', 'new', false),
        replace: () => fixture.workspace.replace('source.txt', base.revision, 'new', false),
        delete: () => fixture.workspace.delete('source.txt', base.revision),
        rename: () => fixture.workspace.rename('source.txt', 'src/new.txt', base.revision),
      };
      await expect(operations[operation]()).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
      expect(filesystem.rename).not.toHaveBeenCalled();
    },
  );
});

/** Every filesystem operation is inert; ancestors obey the operating system's ENOTDIR semantics. */
function virtualWorkspace() {
  const nodes = new Map<string, Buffer | null>([
    ['/fixture', null],
    ['/fixture/src', null],
    ['/fixture/src/file.txt', Buffer.from('base')],
    ['/fixture/source.txt', Buffer.from('base')],
  ]);
  const inspect = (path: string) => {
    for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) {
      if (nodes.get(parent) instanceof Buffer) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
    }
    const node = nodes.get(path);
    if (node === undefined) throw Object.assign(new Error('Missing path'), { code: 'ENOENT' });
    return {
      dev: 7,
      ino: path.length,
      mode: 0o100644,
      size: node?.length ?? 0,
      isSymbolicLink: () => false,
      isDirectory: () => node === null,
      isFile: () => node instanceof Buffer,
    };
  };
  filesystem.lstat.mockImplementation(async (path: string) => inspect(path));
  filesystem.stat.mockImplementation(async (path: string) => inspect(path));
  filesystem.unlink.mockResolvedValue(undefined);
  filesystem.realpath.mockImplementation(async (path: string) => {
    inspect(path);
    return path;
  });
  filesystem.open.mockImplementation(async (path: string) => {
    const info = inspect(path);
    const bytes = nodes.get(path);
    if (!bytes) throw new Error('Only files can be opened in this fixture.');
    let offset = 0;
    return {
      stat: async () => info,
      close: async () => {},
      readFile: async () => bytes,
      read: async (buffer: Buffer) => {
        const bytesRead = bytes.copy(buffer, 0, offset, offset + buffer.length);
        offset += bytesRead;
        return { bytesRead, buffer };
      },
    };
  });
  return { nodes, workspace: new FileSystemWorkspaceTextStore('/fixture') };
}
