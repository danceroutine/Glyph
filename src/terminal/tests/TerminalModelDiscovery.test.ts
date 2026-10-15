import { describe, expect, it, vi } from 'vitest';
import { GlyphService } from '#src/application/GlyphService.js';
import type { ChatAccount } from '#src/chat/ChatAccount.js';
import type { HttpClient } from '#src/http/HttpClient.js';
import { NullLogger } from '#src/observability/NullLogger.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { OpenAIBackend } from '#src/providers/openai/OpenAIBackend.js';
import { OpenAIModelCatalog } from '#src/providers/openai/OpenAIModelCatalog.js';
import type { OpenAIAccountStore } from '#src/providers/openai/auth/OpenAIAccountStore.js';
import type { OpenAISessionService } from '#src/providers/openai/auth/OpenAISessionService.js';
import { AccountSelectionType } from '#src/terminal/AccountSelectionType.js';
import { TerminalApplication } from '#src/terminal/TerminalApplication.js';
import type { TerminalUI } from '#src/terminal/TerminalUI.js';

const configuration = {
  issuer: 'https://auth.example.test',
  resource: 'https://api.example.test/v1',
  scopes: 'openid plan',
  planScope: 'plan',
  requestTimeoutMs: 30_000,
};

describe('model discovery cancellation', () => {
  it('aborts terminal catalog discovery and releases credentials promptly on shutdown', async () => {
    const fixture = discoveryFixture();
    const shutdown = new AbortController();
    const glyph = new GlyphService(fixture.backend, new NullLogger());
    const ui = {
      showWelcome: vi.fn(),
      chooseAccount: async (accounts: readonly ChatAccount[]) => ({
        type: AccountSelectionType.ACCOUNT,
        account: accounts[0]!,
      }),
      chooseModel: vi.fn(async () => ({ slug: 'model', name: 'Model' })),
      showError: vi.fn(),
    } as unknown as TerminalUI;
    const application = new TerminalApplication(glyph, ui, shutdown.signal, {
      projectContext: {
        id: 'project',
        mutationIdentity: 'project',
        kind: ProjectContextKind.FOLDER,
        name: 'Project',
        authority: 'file',
        roots: [{ name: 'Project', path: '/project' }],
      },
    });
    const running = application.run();
    try {
      await vi.waitFor(() => expect(fixture.get).toHaveBeenCalledOnce());
      shutdown.abort(new Error('Application stopped.'));
      await vi.waitFor(() => expect(fixture.store.release).toHaveBeenCalledOnce(), { timeout: 300 });
      expect(fixture.get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(ui.chooseModel).not.toHaveBeenCalled();
      expect(ui.showError).not.toHaveBeenCalled();
      expect(await running).toBe(0);
    } finally {
      shutdown.abort();
      fixture.failRequests();
      await running;
    }
  });

  it('aborts catalog requests when their backend is disposed without aborting a peer backend', async () => {
    const fixture = discoveryFixture();
    const peer = discoveryFixture();
    await fixture.backend.initialize();
    await peer.backend.initialize();
    const pending = fixture.backend.listModels(fixture.backend.accounts[0]!).catch(error => error);
    const other = peer.backend.listModels(peer.backend.accounts[0]!).catch(error => error);
    try {
      await vi.waitFor(() => expect(fixture.get).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(peer.get).toHaveBeenCalledOnce());
      await fixture.backend.dispose();
      expect(fixture.get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(peer.get.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      expect(await pending).toBeInstanceOf(Error);
    } finally {
      fixture.failRequests();
      peer.failRequests();
      await Promise.all([pending, other]);
      await Promise.all([fixture.backend.dispose(), peer.backend.dispose()]);
    }
  });

  it('aborts discovery when the shared credential owner shuts down before workspace cleanup', async () => {
    const owner = new AbortController();
    const fixture = discoveryFixture(owner.signal);
    await fixture.backend.initialize();
    const pending = fixture.backend.listModels(fixture.backend.accounts[0]!).catch(error => error);
    try {
      await vi.waitFor(() => expect(fixture.get).toHaveBeenCalledOnce());
      owner.abort(new Error('Credential owner stopped.'));
      expect(fixture.get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(await pending).toBeInstanceOf(Error);
    } finally {
      fixture.failRequests();
      await pending;
      await fixture.backend.dispose();
    }
  });

  it('cancels only the discovery caller waiting on shared credentials and never starts its catalog request later', async () => {
    const fixture = discoveryFixture();
    let release!: (token: string) => void;
    const credentials = new Promise<string>(resolve => {
      release = resolve;
    });
    fixture.session.accessToken.mockReturnValue(credentials);
    const cancellation = new AbortController();
    await fixture.backend.initialize();
    let completed = false;
    const pending = fixture.backend
      .listModels(fixture.backend.accounts[0]!, cancellation.signal)
      .catch(error => error)
      .finally(() => {
        completed = true;
      });
    try {
      await vi.waitFor(() => expect(fixture.session.accessToken).toHaveBeenCalledOnce());
      cancellation.abort(new Error('Discovery cancelled.'));
      await vi.waitFor(() => expect(completed).toBe(true), { timeout: 300 });
      expect(await pending).toBeInstanceOf(Error);
      expect(fixture.session.dispose).not.toHaveBeenCalled();
      release('shared-refreshed-token');
      expect(await credentials).toBe('shared-refreshed-token');
      await Promise.resolve();
      expect(fixture.get).not.toHaveBeenCalled();
    } finally {
      cancellation.abort();
      release('cleanup-token');
      // An unfixed backend starts discovery when these credentials arrive.
      await Promise.resolve();
      fixture.failRequests();
      await pending;
      await fixture.backend.dispose();
    }
  });

  it('cancels one catalog caller without cancelling another request on the same backend', async () => {
    const fixture = discoveryFixture();
    await fixture.backend.initialize();
    const cancellation = new AbortController();
    const cancelled = fixture.backend
      .listModels(fixture.backend.accounts[0]!, cancellation.signal)
      .catch(error => error);
    const continued = fixture.backend.listModels(fixture.backend.accounts[0]!).catch(error => error);
    try {
      await vi.waitFor(() => expect(fixture.get).toHaveBeenCalledTimes(2));
      cancellation.abort(new Error('Only this catalog request stopped.'));
      expect(await cancelled).toBeInstanceOf(Error);
      expect(fixture.get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(fixture.get.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
      expect(fixture.session.dispose).not.toHaveBeenCalled();
    } finally {
      fixture.failRequests();
      await Promise.all([cancelled, continued]);
      await fixture.backend.dispose();
    }
  });

  it('does not begin credential lookup for an already-cancelled discovery', async () => {
    const fixture = discoveryFixture();
    const cancellation = new AbortController();
    cancellation.abort(new Error('Discovery cancelled.'));
    const pending = fixture.backend.listModels(fixture.backend.accounts[0]!, cancellation.signal).catch(error => error);
    try {
      await Promise.resolve();
      expect(fixture.session.accessToken).not.toHaveBeenCalled();
      expect(await pending).toBeInstanceOf(Error);
      expect(fixture.get).not.toHaveBeenCalled();
    } finally {
      fixture.failRequests();
      await pending;
    }
  });
});

function discoveryFixture(lifetimeSignal?: AbortSignal) {
  const account = {
    clientId: 'client',
    subject: 'subject',
    email: 'fixture@example.test',
    planNoticeSeen: true,
    tokens: {
      accessToken: 'token',
      refreshToken: 'refresh',
      idToken: 'id',
      expiresAt: Number.MAX_SAFE_INTEGER,
      scopes: ['plan'],
    },
  };
  const store: OpenAIAccountStore = {
    state: { version: 1, hostId: 'fixture', accounts: [account] },
    ...(lifetimeSignal ? { lifetimeSignal } : {}),
    acquire: vi.fn(async () => {}),
    load: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  const session = {
    accessToken: vi.fn(async () => 'token'),
    dispose: vi.fn(async () => {}),
    signIn: vi.fn(async () => account),
    logout: vi.fn(async () => true),
    redact: (text: string) => text,
  } satisfies OpenAISessionService;
  const rejectRequests = new Set<(error: Error) => void>();
  const get = vi.fn<HttpClient['get']>(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        rejectRequests.add(reject);
        if (options?.signal?.aborted) reject(options.signal.reason);
        options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      }),
  );
  const catalog = new OpenAIModelCatalog(configuration, { get, post: vi.fn() });
  const backend = new OpenAIBackend(store, session, catalog, { create: vi.fn() }, configuration);
  return {
    store,
    session,
    get,
    backend,
    failRequests: () => {
      for (const reject of rejectRequests) reject(new Error('Fixture stopped.'));
    },
  };
}
