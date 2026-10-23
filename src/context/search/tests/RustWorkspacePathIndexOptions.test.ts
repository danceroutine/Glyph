import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { rustWorkspacePathIndexOptionsSchema } from '#src/context/search/RustWorkspacePathIndexOptions.js';

async function loadSchemaOnPlatform(platform: NodeJS.Platform) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', original);
  });
  vi.resetModules();
  const module = await import('#src/context/search/RustWorkspacePathIndexOptions.js');
  return module.rustWorkspacePathIndexOptionsSchema;
}

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
      caseSensitive: process.platform !== 'darwin' && process.platform !== 'win32',
    });
  });

  it('rejects unknown options', () => {
    expect(() =>
      rustWorkspacePathIndexOptionsSchema.parse({ binaryPath: '/bin/index', root: '/project', extra: true }),
    ).toThrow();
  });

  it.each([
    ['linux', true],
    ['darwin', false],
    ['win32', false],
  ] as const)('defaults path matching on %s to case sensitivity %s', async (platform, caseSensitive) => {
    const schema = await loadSchemaOnPlatform(platform);

    expect(schema.parse({ binaryPath: '/bin/index', root: '/project' }).caseSensitive).toBe(caseSensitive);
  });
});
