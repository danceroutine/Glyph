import { describe, expect, it } from 'vitest';
import type { Logger } from '#src/observability/Logger.js';
import { NullLogger } from '#src/observability/NullLogger.js';

describe(NullLogger, () => {
  describe(NullLogger.prototype.forNamespace, () => {
    it('returns the same logger for any namespace', () => {
      const logger: Logger = new NullLogger();

      expect(logger.forNamespace('chat')).toBe(logger);
    });
  });

  it('discards every log level without producing a value', () => {
    const logger: Logger = new NullLogger();

    expect(logger.trace('trace', { detail: 1 })).toBeUndefined();
    expect(logger.debug('debug')).toBeUndefined();
    expect(logger.info('info')).toBeUndefined();
    expect(logger.warn('warn')).toBeUndefined();
    expect(logger.error('error', new Error('ignored'))).toBeUndefined();
  });
});
