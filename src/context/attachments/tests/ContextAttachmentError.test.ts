import { describe, expect, it } from 'vitest';
import { ContextAttachmentError } from '#src/context/attachments/ContextAttachmentError.js';
import { ContextAttachmentFailureReason } from '#src/context/attachments/ContextAttachmentFailureReason.js';

describe(ContextAttachmentError, () => {
  it('defaults to carrying no failure details', () => {
    const error = new ContextAttachmentError(ContextAttachmentFailureReason.READ_FAILED, 'Could not read.');

    expect(error.details).toEqual({});
    expect(error.reason).toBe(ContextAttachmentFailureReason.READ_FAILED);
    expect(error.message).toBe('Could not read.');
  });

  it('preserves the underlying cause', () => {
    const cause = new Error('disk unavailable');

    const error = new ContextAttachmentError(
      ContextAttachmentFailureReason.READ_FAILED,
      'Could not read.',
      {},
      { cause },
    );

    expect(error.cause).toBe(cause);
  });

  describe(ContextAttachmentError.prototype.toJSON, () => {
    it('serializes the failure code, message, and every detail', () => {
      const error = new ContextAttachmentError(ContextAttachmentFailureReason.FILE_SIZE_LIMIT_EXCEEDED, 'Too large.', {
        path: 'large.ts',
        limit: 4,
        actual: 5,
      });

      expect(error.toJSON()).toEqual({
        code: ContextAttachmentFailureReason.FILE_SIZE_LIMIT_EXCEEDED,
        message: 'Too large.',
        path: 'large.ts',
        limit: 4,
        actual: 5,
      });
    });

    it('serializes without details when none were provided', () => {
      const error = new ContextAttachmentError(ContextAttachmentFailureReason.INVALID_REFERENCE, 'Invalid.');

      expect(JSON.parse(JSON.stringify(error))).toEqual({
        code: ContextAttachmentFailureReason.INVALID_REFERENCE,
        message: 'Invalid.',
      });
    });
  });
});
