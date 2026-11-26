import { expect, it, vi } from 'vitest';
import { inventoryFiles } from '#src/skills/skillPackageInventory.js';
vi.mock('node:fs/promises', async importActual => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async () => ({ isDirectory: () => true }),
    opendir: async (directory: string) =>
      directory === '/package'
        ? Array.from({ length: 8451 }, (_, i) => ({ name: String(i), isDirectory: () => true }))
        : [],
  };
});
it('bounds unindexed empty directory trees independently of the package file limit', async () => {
  await expect(inventoryFiles('/package')).rejects.toThrow('directory budget');
});
