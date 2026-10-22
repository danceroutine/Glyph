import { constants } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';

const filesystem = vi.hoisted(() => ({
  lstat: vi.fn(),
  realpath: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  ...filesystem,
}));

afterEach(() => vi.resetAllMocks());

describe('workspace reads bind inspected paths to opened descriptors', () => {
  for (const maxBytes of [undefined, 64]) {
    const mode = maxBytes === undefined ? 'unbounded' : 'bounded';
    const options = maxBytes === undefined ? {} : { maxBytes };

    it.each(['directory', 'fifo', 'socket'] as const)(
      `rejects a replacement %s before loading an ${mode} snapshot`,
      async replacement => {
        const fixture = readFixture();
        fixture.handle.stat.mockResolvedValue({ ...fixture.info, isFile: () => false });
        await expect(fixture.store.read('file.txt', options)).rejects.toMatchObject({
          reason: EditFailureReason.UNSUPPORTED,
        });
        expect(fixture.handle.read).not.toHaveBeenCalled();
        expect(fixture.handle.readFile).not.toHaveBeenCalled();
        expect(filesystem.readFile).not.toHaveBeenCalled();
        expect(fixture.handle.close).toHaveBeenCalledTimes(1);
        if (replacement === 'fifo' && process.platform !== 'win32') {
          expect(Number(filesystem.open.mock.calls[0]?.[1]) & constants.O_NONBLOCK).not.toBe(0);
        }
      },
    );

    it.each(['inode', 'device'] as const)(
      `rejects a changed %s identity before loading an ${mode} snapshot`,
      async field => {
        const fixture = readFixture();
        fixture.handle.stat.mockResolvedValue({
          ...fixture.info,
          ...(field === 'inode' ? { ino: 99 } : { dev: 99 }),
        });
        await expect(fixture.store.read('file.txt', options)).rejects.toMatchObject({
          reason: EditFailureReason.STALE,
        });
        expect(fixture.handle.read).not.toHaveBeenCalled();
        expect(fixture.handle.readFile).not.toHaveBeenCalled();
        expect(filesystem.readFile).not.toHaveBeenCalled();
        expect(fixture.handle.close).toHaveBeenCalledTimes(1);
      },
    );

    it.skipIf(process.platform === 'win32')(
      `refuses a replaced symlink at the descriptor boundary for ${mode} reads`,
      async () => {
        const fixture = readFixture();
        filesystem.open.mockImplementation(async (_path, flags) => {
          if (Number(flags) & constants.O_NOFOLLOW) {
            throw Object.assign(new Error('fixture symlink rejected'), { code: 'ELOOP' });
          }
          return fixture.handle;
        });
        await expect(fixture.store.read('file.txt', options)).rejects.toMatchObject({
          reason: EditFailureReason.UNSUPPORTED,
        });
        expect(filesystem.readFile).not.toHaveBeenCalled();
        expect(fixture.handle.readFile).not.toHaveBeenCalled();
        expect(fixture.handle.read).not.toHaveBeenCalled();
      },
    );

    it(`uses the validated descriptor for ${mode} reads and preserves BOM, literal U+FEFF, and opened metadata`, async () => {
      const fixture = readFixture(Buffer.from('\uFEFF\uFEFFbody\r\n'));
      fixture.handle.stat.mockResolvedValue({ ...fixture.info, mode: 0o100600 });
      await expect(fixture.store.read('file.txt', options)).resolves.toMatchObject({
        text: '\uFEFFbody\r\n',
        byteOrderMark: true,
        identity: '7:11',
        mode: 0o600,
      });
      expect(filesystem.open).toHaveBeenCalledTimes(1);
      expect(filesystem.readFile).not.toHaveBeenCalled();
      expect(fixture.handle.close).toHaveBeenCalledTimes(1);
    });

    it(`closes the descriptor when validation fails during an ${mode} read`, async () => {
      const fixture = readFixture();
      fixture.handle.stat.mockRejectedValue(new Error('fixture stat failure'));
      await expect(fixture.store.read('file.txt', options)).rejects.toThrow('fixture stat failure');
      expect(fixture.handle.close).toHaveBeenCalledTimes(1);
      expect(fixture.handle.read).not.toHaveBeenCalled();
      expect(fixture.handle.readFile).not.toHaveBeenCalled();
    });
  }

  it('bounds allocation if the validated file grows beyond its reported size', async () => {
    const fixture = readFixture(Buffer.from('growing content'));
    fixture.handle.stat.mockResolvedValue({ ...fixture.info, size: 2 });
    await expect(fixture.store.read('file.txt', { maxBytes: 4 })).rejects.toMatchObject({
      maxBytes: 4,
      actualBytes: 5,
    });
    expect(fixture.handle.read).toHaveBeenCalledTimes(1);
    expect(fixture.handle.read.mock.calls[0]?.[0].length).toBe(5);
    expect(fixture.handle.readFile).not.toHaveBeenCalled();
    expect(fixture.handle.close).toHaveBeenCalledTimes(1);
  });
});

/** Inert filesystem calls model races without replacing files or opening any real special resource. */
function readFixture(bytes = Buffer.from('body')) {
  const info = {
    dev: 7,
    ino: 11,
    mode: 0o100644,
    size: bytes.length,
    isSymbolicLink: () => false,
    isFile: () => true,
  };
  let offset = 0;
  const handle = {
    stat: vi.fn(async () => info),
    close: vi.fn(async () => {}),
    readFile: vi.fn(async () => bytes),
    read: vi.fn(async (buffer: Buffer) => {
      const bytesRead = bytes.copy(buffer, 0, offset, offset + buffer.length);
      offset += bytesRead;
      return { bytesRead, buffer };
    }),
  };
  filesystem.lstat.mockResolvedValue(info);
  filesystem.realpath.mockImplementation(async (path: string) => path);
  filesystem.readFile.mockResolvedValue(bytes);
  filesystem.open.mockResolvedValue(handle);
  return { store: new FileSystemWorkspaceTextStore('/fixture'), handle, info };
}
