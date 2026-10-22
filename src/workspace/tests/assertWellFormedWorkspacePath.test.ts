import { describe, expect, it } from 'vitest';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { assertWellFormedWorkspacePath } from '#src/workspace/assertWellFormedWorkspacePath.js';

describe(assertWellFormedWorkspacePath, () => {
  it.each(['\uD800', '\uDC00', '\uD800\uD800', '\uDC00\uD800', 'folder/\uD800.txt'])(
    'rejects filename %j when encoding would change its identity',
    path => {
      expect(() => {
        assertWellFormedWorkspacePath(path);
      }).toThrow(
        expect.objectContaining({
          reason: EditFailureReason.UNSUPPORTED,
        }),
      );
    },
  );

  it.each(['🧪/file.txt', 'é.txt', 'e\u0301.txt', '\uFFFD.txt', 'folder/file.txt'])(
    'preserves the well-formed filename %j without normalization',
    path => {
      expect(() => {
        assertWellFormedWorkspacePath(path);
      }).not.toThrow();
    },
  );
});
