import { describe, expect, it, vi } from 'vitest';
import { rename, writeFile, rm } from 'node:fs/promises';
import { FileOpenAIAccountStore } from '#src/providers/openai/auth/FileOpenAIAccountStore.js';

vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof import('node:fs/promises')>()),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

describe(FileOpenAIAccountStore, () => {
  it('[round2-04] keeps both accounts’ newest credentials when an earlier save is delayed', async () => {
    const files = new Map<string, string>();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const firstRename = new Promise<void>(resolve => {
      entered = resolve;
    });
    let renames = 0;
    vi.mocked(writeFile).mockImplementation(async (path, contents) => {
      files.set(String(path), String(contents));
    });
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (++renames === 1) {
        entered();
        await blocked;
      }
      files.set(String(to), files.get(String(from))!);
      files.delete(String(from));
    });
    vi.mocked(rm).mockImplementation(async path => {
      files.delete(String(path));
    });
    const store = new FileOpenAIAccountStore('/memory-only');
    const tokens = (accessToken: string) => ({
      accessToken,
      refreshToken: 'fixture',
      idToken: 'fixture',
      expiresAt: 9999999999999,
      scopes: ['plan'],
    });
    store.state.accounts.push(
      { clientId: 'a', subject: 'a', email: 'a@example.test', tokens: tokens('a-new') },
      { clientId: 'b', subject: 'b', email: 'b@example.test', tokens: tokens('b-old') },
    );
    const first = store.save();
    await firstRename;
    store.state.accounts[1]!.tokens = tokens('b-new');
    const second = store.save();
    // In-memory writes settle immediately, letting an unordered second rename
    // overtake the blocked first rename without timing or real filesystem races.
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    const persisted = JSON.parse(files.get('/memory-only/accounts.json')!);
    expect(
      persisted.accounts.map((account: { tokens: { accessToken: string } }) => account.tokens.accessToken),
    ).toEqual(['a-new', 'b-new']);
  });
});
