import { describe, expect, it, vi } from 'vitest';
import type { OpenAIConfiguration } from '#src/providers/openai/OpenAIConfiguration.js';
import type { OpenAIAccount } from '#src/providers/openai/auth/OpenAIAccount.js';
import type { OpenAIAccountStore } from '#src/providers/openai/auth/OpenAIAccountStore.js';
import { OpenAIAuthenticationClient } from '#src/providers/openai/auth/OpenAIAuthenticationClient.js';
import { OpenAISession } from '#src/providers/openai/auth/OpenAISession.js';

function fixture() {
  const configuration: OpenAIConfiguration = {
    issuer: 'https://issuer.example.test',
    resource: 'https://api.example.test',
    scopes: 'plan',
    planScope: 'plan',
    requestTimeoutMs: 1000,
  };
  const account: OpenAIAccount = {
    clientId: 'fixture',
    subject: 'fixture',
    email: 'fixture@example.test',
    tokens: {
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      idToken: 'synthetic-id',
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ['plan'],
    },
  };
  let durable = structuredClone(account);
  const store: OpenAIAccountStore = {
    state: { version: 1, hostId: 'fixture', accounts: [account] },
    acquire: vi.fn(),
    load: vi.fn(),
    release: vi.fn(),
    save: vi.fn(async () => {
      durable = structuredClone(account);
    }),
  };
  const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
  const revoke = vi.spyOn(authentication, 'revoke').mockResolvedValue(true);
  const session = new OpenAISession(store, authentication, configuration);
  return { account, store, authentication, configuration, session, revoke, durable: () => durable };
}

describe('security: truthful logout after persistence failure', () => {
  /**
   * After reopening locally signed-out state, no token is available to contact
   * the issuer. This cannot confirm revocation of copies. Exercise the real
   * authentication client with recording HTTP methods; absence is unconfirmed.
   */
  it('does not claim issuer confirmation when no revocation credential is available', async () => {
    const f = fixture();
    f.revoke.mockRestore();
    delete f.account.tokens;
    await expect(f.session.logout(f.account)).resolves.toBe(false);
  });
  /**
   * A full/unavailable state volume can reject logout's first save. Tokens must
   * become unusable for inference immediately, but a retry must still revoke
   * the original credential rather than claim success through a no-token shortcut.
   * Durable state is copied only by successful fake saves, so the test also shows
   * what restart would recover after failure. No real credentials/issuer are used.
   */
  it('retains revocation authority across a failed save and a same-account retry', async () => {
    const f = fixture();
    const original = structuredClone(f.account);
    vi.mocked(f.store.save).mockRejectedValueOnce(new Error('fixture quota exceeded'));
    await expect(f.session.logout(f.account)).rejects.toThrow('fixture quota exceeded');
    expect(f.account.tokens).toBeUndefined();
    expect(f.durable()).toEqual(original);
    await expect(f.session.accessToken(f.account)).rejects.toThrow(/signed out/u);
    await expect(f.session.logout(f.account)).resolves.toBe(true);
    expect(f.revoke).toHaveBeenLastCalledWith(original, undefined);
    expect(f.durable().tokens).toBeUndefined();
  });

  /**
   * Multiple workspaces borrow the same account. Disposing the failed caller
   * must not lose pending revocation before another workspace retries. This
   * establishes process-local recovery, not durable revocation across a crash.
   */
  it('lets a peer workspace retry revocation after the original caller is disposed', async () => {
    const f = fixture();
    const original = structuredClone(f.account);
    vi.mocked(f.store.save).mockRejectedValueOnce(new Error('fixture save failure'));
    await expect(f.session.logout(f.account)).rejects.toThrow();
    await f.session.dispose();
    const peer = new OpenAISession(f.store, f.authentication, f.configuration);
    await expect(peer.logout(f.account)).resolves.toBe(true);
    expect(f.revoke).toHaveBeenLastCalledWith(original, undefined);
  });

  /**
   * Local removal can succeed while the issuer is unavailable. Repeated logout
   * must keep reporting unconfirmed revocation and retry the original token;
   * missing local credentials must not be promoted to remote confirmation.
   */
  it('does not report remote success after an unconfirmed revocation', async () => {
    const f = fixture();
    const original = structuredClone(f.account);
    f.revoke.mockResolvedValue(false);
    await expect(f.session.logout(f.account)).resolves.toBe(false);
    await expect(f.session.logout(f.account)).resolves.toBe(false);
    expect(f.revoke).toHaveBeenLastCalledWith(original, undefined);
    expect(f.durable().tokens).toBeUndefined();
  });
});
