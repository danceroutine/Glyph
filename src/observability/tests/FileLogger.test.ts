import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLogger } from '../FileLogger.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(FileLogger, () => {
  describe(FileLogger.prototype.trace, () => {
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
