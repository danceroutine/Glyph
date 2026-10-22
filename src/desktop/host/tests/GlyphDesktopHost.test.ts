import { describe, expect, beforeEach, it, onTestFinished, vi, type Mock } from 'vitest';
vi.mock('#src/desktop/protocol/typeguards/isGlyphRequestEnvelope.ts', () => ({
  isGlyphRequestEnvelope: vi.fn(),
}));
import { GLYPH_DESKTOP_PROTOCOL_VERSION } from '#src/desktop/protocol/GlyphDesktopProtocolVersion.js';
import { GlyphHostEventType } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphHostStatus } from '#src/desktop/protocol/events/GlyphHostStatus.js';
import { GlyphWorkbenchCommandType } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import type { GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import type { GlyphHostEventEnvelope } from '#src/desktop/protocol/events/GlyphHostEventEnvelope.js';
import type { GlyphRequestEnvelope } from '#src/desktop/protocol/GlyphRequestEnvelope.js';
import type { GlyphWorkbenchCommand } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import { GlyphDesktopHost } from '#src/desktop/host/GlyphDesktopHost.js';
import {
  type GlyphDesktopWorkspaceRuntime,
  type GlyphRuntimeCommand,
  type GlyphRuntimeSnapshot,
} from '#src/desktop/host/GlyphDesktopWorkspaceRuntime.js';
import type { GlyphDesktopWorkspaceRuntimeFactory } from '#src/desktop/host/GlyphDesktopWorkspaceRuntimeFactory.js';
import { GlyphHostEventCursor, GlyphHostEventDisposition } from '#src/desktop/workbench/GlyphHostEventCursor.js';
import { GlyphWorkbenchProjection } from '#src/desktop/workbench/GlyphWorkbenchProjection.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { isGlyphRequestEnvelope } from '#src/desktop/protocol/typeguards/isGlyphRequestEnvelope.ts';

const owner = { profileId: 'profile', windowId: 'owner', workspaceId: 'workspace' } as const;
const peer = { ...owner, windowId: 'peer' } as const;
const roots = [{ name: 'project', uri: 'file:///project', canonicalPath: '/project' }] as const;

describe(GlyphDesktopHost, () => {
  beforeEach(() => {
    vi.mocked(isGlyphRequestEnvelope).mockReturnValue(true);
  });

  describe(GlyphDesktopHost.prototype.receive, () => {
    it('rejects invalid request envelopes', async () => {
      vi.mocked(isGlyphRequestEnvelope).mockReturnValue(false);
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      // @ts-expect-error - invalid request envelope
      await expect(fixture.receive('owner', owner, 'invalid', { type: 'invalid' })).rejects.toThrow(
        'Invalid request envelope.',
      );
    });
  });

  it('rejects new commands as soon as host shutdown starts, before runtime disposal finishes', async () => {
    const fixture = new HostFixture();
    fixture.connect('owner', owner);
    await fixture.receive('owner', owner, 'attach', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: true,
    });
    const stopping = fixture.host.dispose();
    await fixture.receive('owner', owner, 'too-late', {
      type: GlyphWorkbenchCommandType.SEND,
      chatId: 'chat',
      runId: 'run',
      text: 'must not start',
      attachments: [],
    });
    await stopping;
    expect(fixture.runtime.handle).not.toHaveBeenCalled();
  });

  it.each(['expiry', 'shutdown'] as const)(
    'does not resurrect a retired runtime through queued attachment after %s',
    async retirement => {
      vi.useFakeTimers();
      const fixture = new HostFixture();
      let release!: () => void;
      const barrier = new Promise<void>(resolve => {
        release = resolve;
      });
      fixture.factory.create.mockImplementationOnce(async () => {
        await barrier;
        return fixture.runtime;
      });
      fixture.connect('owner', owner);
      const first = fixture.receive('owner', owner, 'initial', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: false,
      });
      const second = fixture.receive('owner', owner, 'grant', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: true,
      });
      let shutdown: Promise<void> | undefined;
      try {
        if (retirement === 'expiry') {
          await fixture.host.disconnect('owner');
          await vi.advanceTimersByTimeAsync(30_000);
        } else shutdown = fixture.host.dispose();
        release();
        await Promise.all([first, second, shutdown]);
        expect(fixture.factory.create).toHaveBeenCalledOnce();
        expect(fixture.runtime.dispose).toHaveBeenCalledOnce();
        if (retirement === 'expiry') {
          fixture.connect('replacement', peer);
          await fixture.receive('replacement', peer, 'attach-replacement', {
            type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
            roots,
            trusted: true,
          });
          expect(
            fixture.events('replacement').find(event => event.event.type === GlyphHostEventType.INITIAL_STATE)?.event,
          ).toMatchObject({ state: { ownerWindowId: peer.windowId, readOnly: false } });
        }
      } finally {
        release();
        await Promise.all([first, second, shutdown]);
        await fixture.host.dispose();
        vi.useRealTimers();
      }
    },
  );

  it('blocks runtime commands while an attachment snapshot is still pending', async () => {
    const fixture = new HostFixture();
    const command = { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true } as const;
    fixture.connect('owner', owner);
    await fixture.receive('owner', owner, 'first', command);
    let release!: (value: GlyphRuntimeSnapshot) => void;
    vi.spyOn(fixture.runtime, 'snapshot').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const attaching = fixture.receive('owner', owner, 'again', command);
    await fixture.receive('owner', owner, 'during', {
      type: GlyphWorkbenchCommandType.SEND,
      chatId: 'chat',
      runId: 'run',
      text: 'blocked',
      attachments: [],
    });
    expect(fixture.runtime.handle).not.toHaveBeenCalled();
    release({ accounts: [], models: [], chats: [], proposals: [], runs: [] });
    await attaching;
    await fixture.receive('owner', owner, 'after', {
      type: GlyphWorkbenchCommandType.SEND,
      chatId: 'chat',
      runId: 'run',
      text: 'allowed',
      attachments: [],
    });
    expect(fixture.runtime.handle).toHaveBeenCalledOnce();
    await fixture.host.dispose();
  });

  it.each([false, true])(
    'serializes an overlapping trust change from %s before allowing runtime commands',
    async initiallyTrusted => {
      const fixture = new HostFixture();
      let release!: () => void;
      const barrier = new Promise<void>(resolve => {
        release = resolve;
      });
      fixture.factory.create.mockImplementationOnce(async () => {
        await barrier;
        return fixture.runtime;
      });
      fixture.connect('owner', owner);
      const first = fixture.receive('owner', owner, 'initial', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: initiallyTrusted,
      });
      await vi.waitFor(() => {
        expect(fixture.factory.create).toHaveBeenCalledOnce();
      });
      const second = fixture.receive('owner', owner, 'changed', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: !initiallyTrusted,
      });
      release();
      await Promise.all([first, second]);
      expect(fixture.factory.create.mock.calls.map(([input]) => (input as { trusted: boolean }).trusted)).toEqual([
        initiallyTrusted,
        !initiallyTrusted,
      ]);
      expect(fixture.runtime.dispose).toHaveBeenCalledOnce();
      await fixture.host.dispose();
    },
  );

  it('passes trust into runtime creation and replaces the deferred runtime before granting mutation authority', async () => {
    const fixture = new HostFixture();
    const create = vi.spyOn(fixture.factory, 'create');
    fixture.connect('owner', owner);
    for (const trusted of [false, true, false]) {
      await fixture.receive('owner', owner, `trust-${create.mock.calls.length}`, {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted,
      });
      expect(create.mock.lastCall?.[0]).toMatchObject({ trusted });
    }
    expect(create).toHaveBeenCalledTimes(3);
    expect(fixture.runtime.dispose).toHaveBeenCalledTimes(2);
    await fixture.host.dispose();
  });

  it('drains the owning runtime when trust is revoked and rejects further mutations', async () => {
    const fixture = new HostFixture();
    fixture.connect('owner', owner);
    await fixture.receive('owner', owner, 'attach', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: true,
    });
    await fixture.receive('owner', owner, 'revoke', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: false,
    });
    expect.soft(fixture.runtime.connectionLost).toHaveBeenCalledWith(owner.windowId);
    expect.soft(fixture.runtime.dispose).toHaveBeenCalledOnce();
    await fixture.receive('owner', owner, 'accept', {
      type: GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM,
      chatId: 'chat',
      proposalId: 'proposal',
      itemId: 'item',
    });
    expect(errorCodes(fixture.events('owner'))).toContain('UNTRUSTED_WORKSPACE');
    await fixture.host.dispose();
  });

  it('never restores an older streaming snapshot over a completed run emitted during capture', async () => {
    const fixture = new HostFixture();
    fixture.connect('owner', owner);
    await fixture.receive('owner', owner, 'attach', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: true,
    });
    const run = {
      chatId: 'chat',
      runId: 'run',
      status: GlyphRunStatus.STREAMING,
      text: 'partial',
      reasoning: '',
      tools: [],
    };
    let finish!: (state: GlyphRuntimeSnapshot) => void;
    const stale = { accounts: [], models: [], chats: [], proposals: [], runs: [run] };
    vi.spyOn(fixture.runtime, 'snapshot')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ ...stale, runs: [{ ...run, status: GlyphRunStatus.COMPLETED, text: 'complete' }] });
    const capturing = fixture.receive('owner', owner, 'snapshot', {
      type: GlyphWorkbenchCommandType.REQUEST_SNAPSHOT,
      afterSequence: 0,
    });
    fixture.runtime.emit({
      type: GlyphHostEventType.RUN_STATE,
      run: { ...run, status: GlyphRunStatus.COMPLETED, text: 'complete' },
    });
    finish(stale);
    await capturing;
    const snapshots = fixture
      .events('owner')
      .filter(envelope => envelope.event.type === GlyphHostEventType.INITIAL_STATE);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.event).toMatchObject({
      state: { runs: [{ status: GlyphRunStatus.COMPLETED, text: 'complete' }] },
    });
    expect(fixture.events('owner').at(-1)?.event).toMatchObject({
      type: GlyphHostEventType.COMMAND_RESULT,
      requestId: 'snapshot',
      ok: true,
    });
    const projection = new GlyphWorkbenchProjection();
    for (const envelope of fixture.events('owner')) projection.accept(envelope.event);
    expect(projection.state.runs[0]).toMatchObject({ status: GlyphRunStatus.COMPLETED, text: 'complete' });
    await fixture.host.dispose();
  });

  it('cleans up an abandoned owner even when runtime initialization outlasts the reconnect grace period', async () => {
    vi.useFakeTimers();
    const fixture = new HostFixture();
    let initialize!: (runtime: GlyphDesktopWorkspaceRuntime) => void;
    fixture.factory.create.mockImplementationOnce(() => {
      return new Promise(resolve => {
        initialize = resolve;
      });
    });
    fixture.connect('owner', owner);
    const attaching = fixture.receive('owner', owner, 'attach', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: true,
    });
    try {
      await fixture.host.disconnect('owner');
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      initialize(fixture.runtime);
      await attaching;
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.runtime.dispose).toHaveBeenCalledOnce();
      fixture.connect('replacement', peer);
      await fixture.receive('replacement', peer, 'attach-replacement', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: true,
      });
      expect(
        fixture.events('replacement').find(value => value.event.type === GlyphHostEventType.INITIAL_STATE)?.event,
      ).toMatchObject({ state: { readOnly: false, ownerWindowId: peer.windowId } });
    } finally {
      initialize(fixture.runtime);
      await attaching;
      await fixture.host.dispose();
      vi.useRealTimers();
    }
  });

  it('waits for the previous owner’s runtime to stop before allowing a replacement writer', async () => {
    const fixture = new HostFixture();
    let finish!: () => void;
    fixture.runtime.dispose.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const attach = { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true } as const;
    fixture.connect('owner', owner);
    await fixture.receive('owner', owner, 'attach', attach);
    const detached = fixture.receive('owner', owner, 'detach', { type: GlyphWorkbenchCommandType.DETACH });
    fixture.connect('replacement', peer);
    const replacement = fixture.receive('replacement', peer, 'attach-replacement', attach);
    try {
      await vi.waitFor(() => {
        expect(fixture.runtime.dispose).toHaveBeenCalledOnce();
      });
      expect(fixture.factory.create).toHaveBeenCalledOnce();
      expect(fixture.events('replacement')).toEqual([]);
    } finally {
      finish();
      await Promise.all([detached, replacement]);
      await fixture.host.dispose();
    }
    expect(
      fixture.events('replacement').find(event => event.event.type === GlyphHostEventType.INITIAL_STATE)?.event,
    ).toMatchObject({ state: { readOnly: false, ownerWindowId: peer.windowId } });
  });

  it('expires an abandoned connection’s ownership and disposes its runtime so a replacement window can write', async () => {
    vi.useFakeTimers();
    const fixture = new HostFixture();
    try {
      fixture.connect('owner', owner);
      const attach = { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true } as const;
      await fixture.receive('owner', owner, 'attach-owner', attach);
      await fixture.host.disconnect('owner');
      // A reconnect grace period is allowed; indefinite ownership is not.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      fixture.connect('replacement', peer);
      await fixture.receive('replacement', peer, 'attach-replacement', attach);
      const snapshot = fixture
        .events('replacement')
        .find(value => value.event.type === GlyphHostEventType.INITIAL_STATE);
      expect.soft(snapshot?.event).toMatchObject({ state: { readOnly: false, ownerWindowId: peer.windowId } });
      expect.soft(fixture.runtime.dispose).toHaveBeenCalledOnce();
    } finally {
      await fixture.host.dispose();
      vi.useRealTimers();
    }
  });

  it.each([3, 520])(
    'recovers a renderer missing %s events using replay or an authoritative snapshot',
    async missingCount => {
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      await fixture.receive('owner', owner, 'attach', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: true,
      });
      const cursor = new GlyphHostEventCursor();
      for (const event of fixture.events('owner')) expect(cursor.accept(event)).toBe(GlyphHostEventDisposition.APPLY);
      const lastApplied = cursor.watermark;
      for (let index = 0; index < missingCount; index++)
        fixture.runtime.emit({ type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.READY });
      const gap = fixture.events('owner').at(-1)!;
      expect(cursor.accept(gap)).toBe(GlyphHostEventDisposition.RECOVER);
      expect(cursor.watermark).toBe(lastApplied);
      const beforeRecovery = fixture.events('owner').length;
      await fixture.receive('owner', owner, 'recover', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: true,
        ...cursor.resume,
      });
      const recovery = fixture.events('owner').slice(beforeRecovery);
      expect(recovery[0]?.event.type).toBe(
        missingCount > 512 ? GlyphHostEventType.INITIAL_STATE : GlyphHostEventType.HOST_STATUS,
      );
      for (const event of recovery) expect(cursor.accept(event)).toBe(GlyphHostEventDisposition.APPLY);
      expect(cursor.watermark).toBe(recovery.at(-1)!.sequence);
      expect(cursor.accept(gap)).toBe(GlyphHostEventDisposition.DUPLICATE);
      expect(fixture.factory.create).toHaveBeenCalledTimes(1);
    },
  );

  it('shares a single initializing runtime when two windows attach concurrently', async () => {
    const fixture = new HostFixture();
    let ready!: (runtime: GlyphDesktopWorkspaceRuntime) => void;
    fixture.factory.create.mockImplementationOnce(() => {
      return new Promise(resolve => {
        ready = resolve;
      });
    });
    fixture.connect('owner', owner);
    fixture.connect('peer', peer);
    const command = { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true } as const;
    const first = fixture.receive('owner', owner, 'attach-owner', command);
    const second = fixture.receive('peer', peer, 'attach-peer', command);
    expect(fixture.factory.create).toHaveBeenCalledTimes(1);
    ready(fixture.runtime);
    await Promise.all([first, second]);
    const peerSnapshot = fixture
      .events('peer')
      .find(envelope => envelope.event.type === GlyphHostEventType.INITIAL_STATE);
    expect(peerSnapshot?.event).toMatchObject({ state: { readOnly: true, ownerWindowId: owner.windowId } });
  });

  it('releases ownership after initialization fails so another window can retry', async () => {
    const fixture = new HostFixture();
    fixture.factory.create.mockRejectedValueOnce(new Error('Initialization failed'));
    fixture.connect('owner', owner);
    fixture.connect('peer', peer);
    const command = { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true } as const;
    await fixture.receive('owner', owner, 'attach-owner', command);
    await fixture.receive('peer', peer, 'attach-peer', command);
    expect(fixture.factory.create).toHaveBeenCalledTimes(2);
    const snapshot = fixture.events('peer').find(envelope => envelope.event.type === GlyphHostEventType.INITIAL_STATE);
    expect(snapshot?.event).toMatchObject({ state: { readOnly: false, ownerWindowId: peer.windowId } });
  });

  it('negotiates identity, deduplicates commands, and publishes ordered events', async () => {
    const fixture = new HostFixture();
    fixture.connect('owner', owner);
    await fixture.receive('owner', owner, 'attach', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: true,
    });

    expect(fixture.factory.create).toHaveBeenCalledTimes(1);
    expect(fixture.events('owner').map(event => event.event.type)).toEqual(['initial_state', 'command_result']);
    expect(fixture.events('owner').map(event => event.sequence)).toEqual([1, 2]);

    const command = { type: GlyphWorkbenchCommandType.LIST_CHATS } as const;
    await fixture.receive('owner', owner, 'list', command);
    await fixture.receive('owner', owner, 'list', command);

    expect(fixture.runtime.handle).toHaveBeenCalledTimes(1);
    expect(fixture.events('owner').map(event => event.event.type)).toEqual([
      'initial_state',
      'command_result',
      'host_status',
      'command_result',
      'command_result',
    ]);
    expect(fixture.events('owner').map(event => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each([1, 2, 999])('rejects spoofed connection authority and incompatible protocol version %s', async version => {
    const fixture = new HostFixture();
    fixture.connect('owner', owner);
    await fixture.host.receive('owner', {
      ...request(owner, 'spoof', { type: GlyphWorkbenchCommandType.LIST_CHATS }),
      windowId: 'other',
    });
    await fixture.host.receive('owner', {
      ...request(owner, 'version', { type: GlyphWorkbenchCommandType.LIST_CHATS }),
      protocolVersion: version,
    });

    expect(errorCodes(fixture.events('owner'))).toEqual(['UNAUTHORIZED', 'PROTOCOL_MISMATCH']);
    expect(fixture.factory.create).not.toHaveBeenCalled();
  });

  it('allows a read-only peer but reserves state-changing commands for the owner', async () => {
    const fixture = new HostFixture();
    fixture.connect('owner', owner);
    fixture.connect('peer', peer);
    await fixture.receive('owner', owner, 'attach-owner', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: true,
    });
    await fixture.receive('peer', peer, 'attach-peer', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: true,
    });
    await fixture.receive('peer', peer, 'read', { type: GlyphWorkbenchCommandType.LIST_CHATS });
    await fixture.receive('peer', peer, 'mutate', {
      type: GlyphWorkbenchCommandType.CANCEL_RUN,
      chatId: 'chat',
      runId: 'run',
    });

    const peerSnapshot = fixture.events('peer').find(
      (
        event,
      ): event is GlyphHostEventEnvelope & {
        event: Extract<GlyphHostEvent, { type: GlyphHostEventType.INITIAL_STATE }>;
      } => event.event.type === GlyphHostEventType.INITIAL_STATE,
    );
    expect(peerSnapshot?.event.state).toMatchObject({ ownerWindowId: 'owner', readOnly: true });
    expect(fixture.runtime.handle).toHaveBeenCalledTimes(1);
    expect(errorCodes(fixture.events('peer'))).toContain('WORKSPACE_BUSY');
  });

  it('journals events while disconnected and replays only within the same host generation', async () => {
    const fixture = new HostFixture();
    fixture.connect('owner', owner);
    await fixture.receive('owner', owner, 'attach', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: true,
    });
    const lastSeen = fixture.events('owner').at(-1)!.sequence;
    await fixture.host.disconnect('owner');

    fixture.connect('owner-reloaded', owner);
    await fixture.receive('owner-reloaded', owner, 'resume', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: true,
      resumeHostGeneration: fixture.host.generation,
      resumeAfterSequence: lastSeen,
    });

    expect(fixture.events('owner-reloaded').map(event => event.event.type)).toEqual(['host_status', 'command_result']);
    expect(fixture.factory.create).toHaveBeenCalledTimes(1);

    await fixture.host.disconnect('owner-reloaded');
    fixture.connect('owner-restarted', owner);
    await fixture.receive('owner-restarted', owner, 'snapshot', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: true,
      resumeHostGeneration: 'old-generation',
      resumeAfterSequence: lastSeen,
    });
    expect(fixture.events('owner-restarted').map(event => event.event.type)).toEqual([
      'initial_state',
      'command_result',
    ]);
  });

  it('disposes the workspace runtime on an explicit owner detach', async () => {
    const fixture = new HostFixture();
    fixture.connect('owner', owner);
    await fixture.receive('owner', owner, 'attach', {
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted: true,
    });
    await fixture.receive('owner', owner, 'detach', { type: GlyphWorkbenchCommandType.DETACH });
    expect(fixture.runtime.connectionLost).toHaveBeenCalledWith('owner');
    expect(fixture.runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('names an unknown owner when a read-only window of an unowned workspace tries to change it', async () => {
    const fixture = new HostFixture();
    const connection = {
      identity: peer,
      attached: true,
      ready: true,
      pendingAttachments: 0,
      trusted: true,
      readOnly: true,
    };

    const events = await (
      fixture.host as unknown as {
        dispatch(connection: unknown, requestId: string, command: GlyphRuntimeCommand): Promise<GlyphHostEvent[]>;
      }
    ).dispatch(connection, 'mutate', { type: GlyphWorkbenchCommandType.CANCEL_RUN, chatId: 'chat', runId: 'run' });

    expect(events).toEqual([
      {
        type: GlyphHostEventType.ERROR,
        requestId: 'mutate',
        error: {
          code: 'WORKSPACE_BUSY',
          message: "Window unknown owns this workspace's Glyph session.",
          retryable: true,
        },
      },
    ]);
    expect(fixture.runtime.handle).not.toHaveBeenCalled();
  });

  it('reports an unavailable runtime to an attached window whose workspace has none', async () => {
    const fixture = new HostFixture();
    const connection = {
      identity: owner,
      attached: true,
      ready: true,
      pendingAttachments: 0,
      trusted: true,
      readOnly: false,
    };

    const events = await (
      fixture.host as unknown as {
        dispatch(connection: unknown, requestId: string, command: GlyphRuntimeCommand): Promise<GlyphHostEvent[]>;
      }
    ).dispatch(connection, 'list', { type: GlyphWorkbenchCommandType.LIST_CHATS });

    expect(events).toEqual([
      {
        type: GlyphHostEventType.ERROR,
        requestId: 'list',
        error: {
          code: 'HOST_UNAVAILABLE',
          message: 'The Glyph workspace runtime is unavailable.',
          retryable: true,
        },
      },
    ]);
    expect(fixture.runtime.handle).not.toHaveBeenCalled();
  });

  describe(GlyphDesktopHost.prototype.connect, () => {
    it('refuses connections once the host has stopped', async () => {
      const fixture = new HostFixture();
      await fixture.host.dispose();
      expect(() => {
        fixture.connect('owner', owner);
      }).toThrow('The Glyph desktop host has stopped.');
    });

    it('refuses a connection id that is already registered', () => {
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      expect(() => {
        fixture.connect('owner', peer);
      }).toThrow('Connection owner is already registered.');
    });

    it('refuses a second live connection for the same window', () => {
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      expect(() => {
        fixture.connect('owner-again', owner);
      }).toThrow('Window owner already has an active Glyph connection.');
    });
  });

  describe(GlyphDesktopHost.prototype.receive, () => {
    it('rejects requests from an unknown connection', async () => {
      const fixture = new HostFixture();
      await expect(
        fixture.host.receive('missing', request(owner, 'list', { type: GlyphWorkbenchCommandType.LIST_CHATS })),
      ).rejects.toThrow('Unknown desktop connection: missing');
    });

    it.each([
      ['profileId', 'The request profile does not match its connection.'],
      ['workspaceId', 'The request workspace does not match its connection.'],
    ])('rejects a request with a spoofed %s', async (field, message) => {
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      await fixture.host.receive('owner', {
        ...request(owner, 'spoof', { type: GlyphWorkbenchCommandType.LIST_CHATS }),
        [field]: 'other',
      });
      expect(fixture.events('owner').map(envelope => envelope.event)).toEqual([
        {
          type: GlyphHostEventType.ERROR,
          requestId: 'spoof',
          error: { code: 'UNAUTHORIZED', message, retryable: false },
        },
      ]);
    });

    it('reports a snapshot request made before any workspace is attached', async () => {
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      await fixture.receive('owner', owner, 'snapshot', {
        type: GlyphWorkbenchCommandType.REQUEST_SNAPSHOT,
        afterSequence: 0,
      });
      expect(fixture.events('owner').map(envelope => envelope.event)).toEqual([
        {
          type: GlyphHostEventType.ERROR,
          requestId: 'snapshot',
          error: { code: 'INVALID_REQUEST', message: 'The Glyph workspace runtime is unavailable.', retryable: true },
        },
      ]);
    });

    it('reports non-error runtime failures as text', async () => {
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      await fixture.receive('owner', owner, 'attach', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: true,
      });
      fixture.runtime.handle.mockRejectedValueOnce('runtime busy');
      await fixture.receive('owner', owner, 'list', { type: GlyphWorkbenchCommandType.LIST_CHATS });
      expect(fixture.events('owner').at(-1)?.event).toEqual({
        type: GlyphHostEventType.ERROR,
        requestId: 'list',
        error: { code: 'INVALID_REQUEST', message: 'runtime busy', retryable: true },
      });
      await fixture.host.dispose();
    });

    it('lets a command broadcast events to every attached window of its workspace', async () => {
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      fixture.connect('peer', peer);
      const attach = { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true } as const;
      await fixture.receive('owner', owner, 'attach-owner', attach);
      await fixture.receive('peer', peer, 'attach-peer', attach);
      fixture.runtime.handle.mockImplementationOnce(async (_command, context) => {
        context?.emit({ type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.READY, message: 'from command' });
      });
      await fixture.receive('owner', owner, 'list', { type: GlyphWorkbenchCommandType.LIST_CHATS });
      expect(fixture.runtime.handle).toHaveBeenCalledWith(
        { type: GlyphWorkbenchCommandType.LIST_CHATS },
        { windowId: 'owner', signal: expect.any(AbortSignal), emit: expect.any(Function) },
      );
      for (const connectionId of ['owner', 'peer'])
        expect(fixture.events(connectionId).map(envelope => envelope.event)).toContainEqual({
          type: GlyphHostEventType.HOST_STATUS,
          status: GlyphHostStatus.READY,
          message: 'from command',
        });
      await fixture.host.dispose();
    });

    it('gives up on a snapshot whose state keeps changing during capture', async () => {
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      await fixture.receive('owner', owner, 'attach', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: true,
      });
      const snapshot = vi.spyOn(fixture.runtime, 'snapshot').mockImplementation(async () => {
        fixture.runtime.emit({ type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.READY });
        return { accounts: [], models: [], chats: [], runs: [], proposals: [] };
      });
      await fixture.receive('owner', owner, 'snapshot', {
        type: GlyphWorkbenchCommandType.REQUEST_SNAPSHOT,
        afterSequence: 0,
      });
      expect(snapshot).toHaveBeenCalledTimes(8);
      expect(fixture.events('owner').at(-1)?.event).toEqual({
        type: GlyphHostEventType.ERROR,
        requestId: 'snapshot',
        error: {
          code: 'INVALID_REQUEST',
          message: 'Workspace state changed during snapshot capture. Retry the snapshot request.',
          retryable: true,
        },
      });
      await fixture.host.dispose();
    });

    it('reports a snapshot interrupted by detaching the workspace', async () => {
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      await fixture.receive('owner', owner, 'attach', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: true,
      });
      let finish!: (state: GlyphRuntimeSnapshot) => void;
      vi.spyOn(fixture.runtime, 'snapshot').mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve;
          }),
      );
      const capturing = fixture.receive('owner', owner, 'snapshot', {
        type: GlyphWorkbenchCommandType.REQUEST_SNAPSHOT,
        afterSequence: 0,
      });
      await fixture.receive('owner', owner, 'detach', { type: GlyphWorkbenchCommandType.DETACH });
      finish({ accounts: [], models: [], chats: [], runs: [], proposals: [] });
      await capturing;
      expect(fixture.events('owner').at(-1)?.event).toEqual({
        type: GlyphHostEventType.ERROR,
        requestId: 'snapshot',
        error: { code: 'INVALID_REQUEST', message: 'The workspace detached during snapshot capture.', retryable: true },
      });
    });

    it('acknowledges a detach from a window that never attached', async () => {
      const fixture = new HostFixture();
      fixture.connect('peer', peer);
      await fixture.receive('peer', peer, 'detach', { type: GlyphWorkbenchCommandType.DETACH });
      expect(fixture.events('peer').map(envelope => envelope.event)).toEqual([
        { type: GlyphHostEventType.COMMAND_RESULT, requestId: 'detach', ok: true },
      ]);
      expect(fixture.runtime.connectionLost).not.toHaveBeenCalled();
    });

    it('keeps the workspace running when a read-only peer detaches', async () => {
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      fixture.connect('peer', peer);
      const attach = { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true } as const;
      await fixture.receive('owner', owner, 'attach-owner', attach);
      await fixture.receive('peer', peer, 'attach-peer', attach);
      await fixture.receive('peer', peer, 'detach', { type: GlyphWorkbenchCommandType.DETACH });
      expect(fixture.runtime.connectionLost).toHaveBeenCalledExactlyOnceWith('peer');
      expect(fixture.runtime.dispose).not.toHaveBeenCalled();
      await fixture.receive('owner', owner, 'list', { type: GlyphWorkbenchCommandType.LIST_CHATS });
      expect(fixture.runtime.handle).toHaveBeenCalledOnce();
      await fixture.host.dispose();
    });

    it('only notifies windows of the detached workspace', async () => {
      const fixture = new HostFixture();
      const elsewhere = { ...peer, workspaceId: 'elsewhere' };
      fixture.connect('owner', owner);
      fixture.connect('elsewhere', elsewhere);
      await fixture.receive('owner', owner, 'attach-owner', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: true,
      });
      await fixture.receive('elsewhere', elsewhere, 'attach-elsewhere', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots: [{ name: 'other', uri: 'file:///other', canonicalPath: '/other' }],
        trusted: true,
      });
      await fixture.receive('owner', owner, 'detach', { type: GlyphWorkbenchCommandType.DETACH });
      expect(fixture.events('owner').map(envelope => envelope.event)).toContainEqual({
        type: GlyphHostEventType.HOST_STATUS,
        status: GlyphHostStatus.DISCONNECTED,
        message: 'The owning window detached.',
      });
      expect(
        fixture
          .events('elsewhere')
          .some(
            envelope =>
              envelope.event.type === GlyphHostEventType.HOST_STATUS &&
              envelope.event.status === GlyphHostStatus.DISCONNECTED,
          ),
      ).toBe(false);
      await fixture.host.dispose();
    });

    it('refuses a peer whose attachment completes after the owner abandoned initialization', async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const fixture = new HostFixture();
      let initialize!: (runtime: GlyphDesktopWorkspaceRuntime) => void;
      fixture.factory.create.mockImplementationOnce(() => {
        return new Promise(resolve => {
          initialize = resolve;
        });
      });
      let finishStop!: () => void;
      fixture.runtime.dispose.mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finishStop = resolve;
          }),
      );
      fixture.connect('owner', owner);
      fixture.connect('peer', peer);
      const attach = { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true } as const;
      const owning = fixture.receive('owner', owner, 'attach-owner', attach);
      const peering = fixture.receive('peer', peer, 'attach-peer', attach);
      await fixture.host.disconnect('owner');
      await vi.advanceTimersByTimeAsync(30_000);
      initialize(fixture.runtime);
      await Promise.all([owning, peering]);
      expect(fixture.events('peer').map(envelope => envelope.event)).toEqual([
        {
          type: GlyphHostEventType.HOST_STATUS,
          status: GlyphHostStatus.DISCONNECTED,
          message: 'The owning window detached.',
        },
        {
          type: GlyphHostEventType.ERROR,
          requestId: 'attach-peer',
          error: {
            code: 'INVALID_REQUEST',
            message: 'The owning window disconnected during workspace initialization.',
            retryable: true,
          },
        },
      ]);
      await vi.waitFor(() => {
        expect(fixture.runtime.dispose).toHaveBeenCalledOnce();
      });
      finishStop();
      await fixture.host.dispose();
    });

    it('releases an abandoned owner whose runtime initialization then fails', async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const fixture = new HostFixture();
      let fail!: (error: Error) => void;
      fixture.factory.create.mockImplementationOnce(() => {
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      });
      fixture.connect('owner', owner);
      const attach = { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true } as const;
      const owning = fixture.receive('owner', owner, 'attach-owner', attach);
      await fixture.host.disconnect('owner');
      await vi.advanceTimersByTimeAsync(30_000);
      fail(new Error('Initialization failed'));
      await owning;
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.runtime.dispose).not.toHaveBeenCalled();
      fixture.connect('replacement', peer);
      await fixture.receive('replacement', peer, 'attach-replacement', attach);
      expect(
        fixture.events('replacement').find(envelope => envelope.event.type === GlyphHostEventType.INITIAL_STATE)?.event,
      ).toMatchObject({ state: { ownerWindowId: peer.windowId, readOnly: false } });
      await fixture.host.dispose();
    });

    it('joins the stop already in progress when a detaching owner also expires', async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const fixture = new HostFixture();
      let finishStop!: () => void;
      fixture.runtime.dispose.mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finishStop = resolve;
          }),
      );
      fixture.connect('owner', owner);
      await fixture.receive('owner', owner, 'attach', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: true,
      });
      const detaching = fixture.receive('owner', owner, 'detach', { type: GlyphWorkbenchCommandType.DETACH });
      await vi.waitFor(() => {
        expect(fixture.runtime.dispose).toHaveBeenCalledOnce();
      });
      await fixture.host.disconnect('owner');
      await vi.advanceTimersByTimeAsync(30_000);
      finishStop();
      await detaching;
      expect(fixture.runtime.dispose).toHaveBeenCalledOnce();
      expect(fixture.runtime.connectionLost).toHaveBeenCalledOnce();
      await fixture.host.dispose();
    });

    it('refuses a replacement writer while cleanup of an abandoned window has failed', async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const fixture = new HostFixture();
      fixture.runtime.dispose.mockRejectedValueOnce(new Error('Stop failed'));
      fixture.connect('owner', owner);
      const attach = { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true } as const;
      await fixture.receive('owner', owner, 'attach-owner', attach);
      await fixture.host.disconnect('owner');
      await vi.advanceTimersByTimeAsync(30_000);
      fixture.connect('replacement', peer);
      await fixture.receive('replacement', peer, 'attach-replacement', attach);
      expect(fixture.events('replacement').map(envelope => envelope.event)).toEqual([
        {
          type: GlyphHostEventType.ERROR,
          requestId: 'attach-replacement',
          error: { code: 'INVALID_REQUEST', message: 'Stop failed', retryable: true },
        },
      ]);
      await fixture.host.dispose();
    });
  });

  describe(GlyphDesktopHost.prototype.disconnect, () => {
    it('ignores unknown connections', async () => {
      const fixture = new HostFixture();
      await expect(fixture.host.disconnect('missing')).resolves.toBeUndefined();
    });
  });

  describe(GlyphDesktopHost.prototype.dispose, () => {
    it('cancels reconnect grace periods of disconnected windows', async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      await fixture.receive('owner', owner, 'attach', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: true,
      });
      await fixture.host.disconnect('owner');
      await fixture.host.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fixture.runtime.connectionLost).toHaveBeenCalledOnce();
      expect(fixture.runtime.dispose).toHaveBeenCalledOnce();
    });

    it('reports every runtime that fails to stop', async () => {
      const fixture = new HostFixture();
      fixture.connect('owner', owner);
      await fixture.receive('owner', owner, 'attach', {
        type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        roots,
        trusted: true,
      });
      const failure = new Error('Stop failed');
      fixture.runtime.dispose.mockRejectedValueOnce(failure);
      await expect(fixture.host.dispose()).rejects.toThrow(
        expect.objectContaining({
          name: 'AggregateError',
          message: 'One or more desktop workspace runtimes failed to stop.',
          errors: [failure],
        }),
      );
    });
  });
});

class HostFixture {
  readonly sent = new Map<string, GlyphHostEventEnvelope[]>();
  readonly runtime = new FakeRuntime();
  readonly factory: GlyphDesktopWorkspaceRuntimeFactory & { create: Mock };
  readonly host: GlyphDesktopHost;

  constructor() {
    const create = vi.fn(async (input: Parameters<GlyphDesktopWorkspaceRuntimeFactory['create']>[0]) => {
      this.runtime.emit = input.emit;
      return this.runtime;
    });
    this.factory = { create };
    this.host = new GlyphDesktopHost(this.factory, 'host-generation');
  }

  connect(connectionId: string, identity: GlyphConnectionIdentity): void {
    const events: GlyphHostEventEnvelope[] = [];
    this.sent.set(connectionId, events);
    this.host.connect(connectionId, identity, event => {
      events.push(event);
    });
  }

  receive(
    connectionId: string,
    identity: GlyphConnectionIdentity,
    requestId: string,
    command: GlyphWorkbenchCommand,
  ): Promise<void> {
    return this.host.receive(connectionId, request(identity, requestId, command));
  }

  events(connectionId: string): readonly GlyphHostEventEnvelope[] {
    return this.sent.get(connectionId) ?? [];
  }
}

class FakeRuntime implements GlyphDesktopWorkspaceRuntime {
  emit: (event: GlyphHostEvent) => void = () => {};
  readonly handle = vi.fn(async (_command: GlyphRuntimeCommand, _context?: GlyphRuntimeContext) => {
    this.emit({ type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.READY });
  });
  readonly connectionLost = vi.fn(async () => {
    this.emit({ type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.RECONNECTING });
  });
  readonly dispose = vi.fn(async () => {});

  snapshot(): Promise<GlyphRuntimeSnapshot> {
    return Promise.resolve({ accounts: [], models: [], chats: [], runs: [], proposals: [] });
  }
}

type GlyphRuntimeContext = Parameters<GlyphDesktopWorkspaceRuntime['handle']>[1];

function request(
  identity: GlyphConnectionIdentity,
  requestId: string,
  command: GlyphWorkbenchCommand,
): GlyphRequestEnvelope {
  return { ...identity, protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION, requestId, command };
}

function errorCodes(events: readonly GlyphHostEventEnvelope[]): string[] {
  return events.flatMap(event => (event.event.type === GlyphHostEventType.ERROR ? [event.event.error.code] : []));
}
