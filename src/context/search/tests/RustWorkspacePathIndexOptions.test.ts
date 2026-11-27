import { describe, expect, it } from 'vitest';
import { workspaceCaseSensitivity } from '#src/workspace/workspaceCaseSensitivity.js';
import { rustWorkspacePathIndexOptionsSchema } from '#src/context/search/RustWorkspacePathIndexOptions.js';

describe('rustWorkspacePathIndexOptionsSchema', () => {
  it('fills every omitted option with its protocol default', () => {
    expect(rustWorkspacePathIndexOptionsSchema.parse({ binaryPath: '/bin/index', root: '/project' })).toEqual({
      binaryPath: '/bin/index',
      root: '/project',
      cachePath: null,
      excludedPaths: [],
      respectGitIgnore: true,
      maxFiles: 2_000_000,
      maxContentSearchFileBytes: 8 * 1_024 * 1_024,
      caseSensitive: workspaceCaseSensitivity('/project'),
    });
  });

  it('rejects unknown options', () => {
    expect(() =>
      rustWorkspacePathIndexOptionsSchema.parse({ binaryPath: '/bin/index', root: '/project', extra: true }),
    ).toThrow();
  });

  it.each([true, false])('preserves an explicitly selected filesystem policy (%s)', caseSensitive => {
    expect(
      rustWorkspacePathIndexOptionsSchema.parse({ binaryPath: '/bin/index', root: '/project', caseSensitive })
        .caseSensitive,
    ).toBe(caseSensitive);
  });
});
