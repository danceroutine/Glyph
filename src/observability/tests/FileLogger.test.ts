import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLogger } from '../FileLogger.ts';

describe(FileLogger, () => {
  describe(FileLogger.prototype.trace, () => {
    it('appends structured entries to a private log file', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-log-'));
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
  });
});
