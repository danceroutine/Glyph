import { link, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileLogger } from '#src/observability/FileLogger.js';
import type { Logger } from '#src/observability/Logger.js';

vi.mock('node:fs/promises', async importOriginal => {
  const filesystem = await importOriginal<typeof import('node:fs/promises')>();
  return { ...filesystem, open: vi.fn(filesystem.open) };
});
const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(open).mockReset();
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(FileLogger, () => {
  describe(FileLogger.prototype.trace, () => {
    it.each(['one logger', 'nested namespaces', 'independent loggers', 'relative path aliases'])(
      'keeps simultaneous large trace records valid when written through %s',
      async writers => {
        const directory = await mkdtemp(join(tmpdir(), 'glyph-log-concurrent-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'glyph.log');
        const logger = new FileLogger(path);
        const pair: Logger[] = [logger, logger];
        if (writers === 'nested namespaces') pair[1] = logger.forNamespace('workspace').forNamespace('provider');
        if (writers === 'independent loggers') pair[1] = new FileLogger(path);
        if (writers === 'relative path aliases') pair[1] = new FileLogger(relative(process.cwd(), path));
        const output = captureChunkedAppends(pair.length);
        const payload = 'x'.repeat(600 * 1024);

        await Promise.all(pair.map((writer, sequence) => writer.trace('record', { sequence, payload })));

        const lines = Buffer.concat(output).toString('utf8').trimEnd().split('\n');
        expect(lines).toHaveLength(2);
        const entries: unknown[] = lines.map(line => JSON.parse(line));
        expect(entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ data: { sequence: 0, payload } }),
            expect.objectContaining({ data: { sequence: 1, payload } }),
          ]),
        );
      },
    );

    it.skipIf(process.platform === 'win32')(
      'coordinates large records through aliases of the parent directory',
      async () => {
        const directory = await mkdtemp(join(tmpdir(), 'glyph-log-directory-alias-'));
        temporaryDirectories.push(directory);
        const alias = join(directory, 'alias');
        await symlink(directory, alias);
        const output = captureChunkedAppends(2);
        await Promise.all([
          new FileLogger(join(directory, 'glyph.log')).trace('first', 'x'.repeat(600 * 1024)),
          new FileLogger(join(alias, 'glyph.log')).trace('second', 'y'.repeat(600 * 1024)),
        ]);
        const lines = Buffer.concat(output).toString('utf8').trimEnd().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines.map(line => JSON.parse(line))).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message: 'first', data: 'x'.repeat(600 * 1024) }),
            expect.objectContaining({ message: 'second', data: 'y'.repeat(600 * 1024) }),
          ]),
        );
      },
    );

    it('writes complete large Unicode records through the real filesystem append loop', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-log-large-records-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'glyph.log');
      const payload = `line one\n${'🧪'.repeat(160 * 1024)}\nline three`;
      const records = Array.from({ length: 8 }, (_, sequence) => ({ sequence, payload }));

      await Promise.all(records.map(record => new FileLogger(path).forNamespace('provider').trace('response', record)));

      const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
      expect(lines).toHaveLength(records.length);
      expect(lines.map(line => JSON.parse(line))).toEqual(
        expect.arrayContaining(records.map(data => expect.objectContaining({ message: 'provider.response', data }))),
      );
    });

    it.each(['permissions', 'append', 'close'] as const)(
      'rejects a failed %s operation while letting later records finish',
      async stage => {
        const directory = await mkdtemp(join(tmpdir(), 'glyph-log-write-failure-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'glyph.log');
        const failure = new Error(`Failed ${stage}`);
        let entered = false;
        let successorChecked = false;
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
          release = resolve;
        });
        const fail = async () => {
          entered = true;
          await gate;
          throw failure;
        };
        vi.mocked(open).mockImplementationOnce(async (...args) => {
          const file = await filesystem.open(...args);
          const close = file.close.bind(file);
          const closed = vi.spyOn(file, 'close');
          if (stage === 'permissions') vi.spyOn(file, 'chmod').mockImplementation(fail);
          if (stage === 'append') vi.spyOn(file, 'writeFile').mockImplementation(fail);
          if (stage === 'close')
            closed.mockImplementation(async () => {
              await close();
              await fail();
            });
          return file;
        });
        vi.mocked(open).mockImplementationOnce(async (...args) => {
          const file = await filesystem.open(...args);
          const inspect = file.stat.bind(file);
          vi.spyOn(file, 'stat').mockImplementation(async options => {
            const result = await inspect(options);
            successorChecked = true;
            return result;
          });
          return file;
        });
        const logger = new FileLogger(path);
        const first = logger.trace('first').then(
          () => undefined,
          error => error,
        );
        let second: Promise<void> | undefined;
        try {
          await vi.waitFor(() => expect(entered).toBe(true));
          second = Promise.resolve(logger.forNamespace('another').info('second'));
          await vi.waitFor(() => expect(successorChecked).toBe(true));
          await new Promise<void>(resolve => setImmediate(resolve));
          release();
          expect(await first).toBe(failure);
          await second;
          await new FileLogger(path).warn('third');
          const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
          const expected = ['another.second', 'third'];
          if (stage === 'close') expected.unshift('first');
          expect(lines.map(line => JSON.parse(line))).toEqual(
            expected.map(message => expect.objectContaining({ message })),
          );
        } finally {
          release();
          await Promise.allSettled([first, second]);
        }
      },
    );

    it('keeps a third writer behind the queued successor when the first writer finishes', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-log-queue-tail-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'glyph.log');
      let opened = 0;
      const checked = new Set<number>();
      const entered = new Set<number>();
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const firstGate = new Promise<void>(resolve => {
        releaseFirst = resolve;
      });
      const secondGate = new Promise<void>(resolve => {
        releaseSecond = resolve;
      });
      vi.mocked(open).mockImplementation(async (...args) => {
        const ordinal = ++opened;
        const file = await filesystem.open(...args);
        const inspect = file.stat.bind(file);
        const append = file.writeFile.bind(file);
        vi.spyOn(file, 'stat').mockImplementation(async options => {
          const result = await inspect(options);
          checked.add(ordinal);
          return result;
        });
        vi.spyOn(file, 'writeFile').mockImplementation(async (...values) => {
          entered.add(ordinal);
          if (ordinal === 1) await firstGate;
          if (ordinal === 2) await secondGate;
          await append(...values);
        });
        return file;
      });
      const first = new FileLogger(path).trace('first');
      let second: Promise<void> | undefined;
      let third: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(entered.has(1)).toBe(true));
        second = new FileLogger(path).trace('second');
        await vi.waitFor(() => expect(checked.has(2)).toBe(true));
        await new Promise<void>(resolve => setImmediate(resolve));
        releaseFirst();
        await first;
        await vi.waitFor(() => expect(entered.has(2)).toBe(true));

        third = new FileLogger(path).trace('third');
        await vi.waitFor(() => expect(checked.has(3)).toBe(true));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(entered.has(3)).toBe(false);
        releaseSecond();
        await Promise.all([second, third]);
        expect(
          (await readFile(path, 'utf8'))
            .trimEnd()
            .split('\n')
            .map(line => JSON.parse(line)),
        ).toEqual(['first', 'second', 'third'].map(message => expect.objectContaining({ message })));
      } finally {
        releaseFirst();
        releaseSecond();
        await Promise.allSettled([first, second, third]);
      }
    });

    it('continues writing another destination while a trace write is pending', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-log-independent-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'slow.log');
      const otherPath = join(directory, 'other.log');
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const file = await filesystem.open(...args);
        const append = file.writeFile.bind(file);
        vi.spyOn(file, 'writeFile').mockImplementation(async (...values) => {
          entered = true;
          await gate;
          await append(...values);
        });
        return file;
      });
      const pending = new FileLogger(path).trace('slow');
      let other: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        let completed = false;
        other = new FileLogger(otherPath).trace('independent').then(() => {
          completed = true;
        });
        await vi.waitFor(() => expect(completed).toBe(true));
        expect(JSON.parse((await readFile(otherPath, 'utf8')).trim())).toMatchObject({ message: 'independent' });
      } finally {
        release();
        await Promise.all([pending, other]);
      }
    });

    it('rejects invalid JSON data and failed opens without poisoning subsequent records', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-log-retry-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'glyph.log');
      const logger = new FileLogger(path);
      await expect(logger.trace('invalid', 1n)).rejects.toThrow();
      const failure = new Error('Open failed');
      vi.mocked(open).mockRejectedValueOnce(failure);
      await expect(logger.error('unavailable')).rejects.toBe(failure);
      await logger.debug('recovered');
      expect(JSON.parse((await readFile(path, 'utf8')).trim())).toMatchObject({ message: 'recovered', level: 'debug' });
    });

    it.skipIf(process.platform === 'win32')(
      'rechecks a destination that gains a hard link while a record is queued',
      async () => {
        const directory = await mkdtemp(join(tmpdir(), 'glyph-log-queued-hardlink-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'glyph.log');
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
          release = resolve;
        });
        let closing = false;
        let checked = false;
        vi.mocked(open)
          .mockImplementationOnce(async (...args) => {
            const file = await filesystem.open(...args);
            const close = file.close.bind(file);
            vi.spyOn(file, 'close').mockImplementation(async () => {
              await close();
              closing = true;
              await gate;
            });
            return file;
          })
          .mockImplementationOnce(async (...args) => {
            const file = await filesystem.open(...args);
            const inspect = file.stat.bind(file);
            vi.spyOn(file, 'stat').mockImplementation(async options => {
              const result = await inspect(options);
              checked = true;
              return result;
            });
            return file;
          });
        const first = new FileLogger(path).trace('first');
        let second: Promise<unknown> | undefined;
        try {
          await vi.waitFor(() => expect(closing).toBe(true));
          second = new FileLogger(path).trace('unsafe').then(
            () => undefined,
            error => error,
          );
          await vi.waitFor(() => expect(checked).toBe(true));
          await link(path, join(directory, 'alias.log'));
          release();
          await first;
          expect(await second).toEqual(new Error('Trace destination must be one uniquely linked regular file.'));
          expect(JSON.parse((await readFile(path, 'utf8')).trim())).toMatchObject({ message: 'first' });
        } finally {
          release();
          await Promise.allSettled([first, second]);
        }
      },
    );

    it('appends structured entries to a private log file', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-log-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'nested', 'glyph.log');
      const logger = new FileLogger(path);

      await logger.trace('provider.trace', { sequence: 1 });
      await logger.forNamespace('application').info('ready');

      const entries = (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map(
          line =>
            JSON.parse(line) as {
              level: string;
              message: string;
            },
        );
      expect(entries).toEqual([
        expect.objectContaining({ level: 'trace', message: 'provider.trace' }),
        expect.objectContaining({ level: 'info', message: 'application.ready' }),
      ]);
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === 'win32')('refuses to follow a replaced trace-file identity', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-log-alias-'));
      temporaryDirectories.push(directory);
      const target = join(directory, 'target.log');
      const alias = join(directory, 'glyph.log');
      await writeFile(target, 'unchanged');
      await symlink(target, alias);

      await expect(new FileLogger(alias).trace('provider.trace')).rejects.toThrow();
      await expect(readFile(target, 'utf8')).resolves.toBe('unchanged');
    });

    it.skipIf(process.platform === 'win32')('refuses a multiply linked trace-file identity', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-log-hardlink-'));
      temporaryDirectories.push(directory);
      const target = join(directory, 'target.log');
      const alias = join(directory, 'glyph.log');
      await writeFile(target, 'unchanged');
      await link(target, alias);

      await expect(new FileLogger(alias).trace('provider.trace')).rejects.toThrow(
        'Trace destination must be one uniquely linked regular file.',
      );
      await expect(readFile(target, 'utf8')).resolves.toBe('unchanged');
    });
  });
});

/** Real descriptors supply identity; scheduled append chunks make interleaving deterministic. */
function captureChunkedAppends(writers: number): Buffer[] {
  const output: Buffer[] = [];
  let opened = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => {
    release = resolve;
  });
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await filesystem.open(...args);
    const identity = await file.stat();
    const bigIdentity = await file.stat({ bigint: true });
    vi.spyOn(file, 'stat').mockImplementation(async options => (options?.bigint ? bigIdentity : identity));
    vi.spyOn(file, 'chmod').mockResolvedValue();
    vi.spyOn(file, 'writeFile').mockImplementation(async data => {
      if (typeof data !== 'string') throw new Error('Expected a serialized log record.');
      const bytes = Buffer.from(data, 'utf8');
      for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
        output.push(bytes.subarray(offset, offset + 512 * 1024));
        await Promise.resolve();
      }
    });
    if (++opened === writers) release();
    await ready;
    return file;
  });
  return output;
}
