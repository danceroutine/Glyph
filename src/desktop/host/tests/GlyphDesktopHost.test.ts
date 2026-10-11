import { describe, expect, it, vi } from 'vitest';
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

const owner = { profileId: 'profile', windowId: 'owner', workspaceId: 'workspace' } as const;
const peer = { ...owner, windowId: 'peer' } as const;
const roots = [{ name: 'project', uri: 'file:///project', canonicalPath: '/project' }] as const;

describe(GlyphDesktopHost, () => {
  it('cleans up an abandoned owner even when runtime initialization outlasts the reconnect grace period', async () => {
    vi.useFakeTimers();
    const fixture = new HostFixture();
    let initialize!: (runtime: GlyphDesktopWorkspaceRuntime) => void;
    fixture.factory.create.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          initialize = resolve;
        }),
    );
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
      await vi.waitFor(() => expect(fixture.runtime.dispose).toHaveBeenCalledOnce());
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

  it('[review-06] expires an abandoned connection’s ownership and disposes its runtime so a replacement window can write', async () => {
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
    fixture.factory.create.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          ready = resolve;
        }),
    );
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

  it('rejects spoofed connection authority and incompatible protocol versions', async () => {
    const fixture = new HostFixture();
    fixture.connect('owner', owner);
    await fixture.host.receive('owner', {
      ...request(owner, 'spoof', { type: GlyphWorkbenchCommandType.LIST_CHATS }),
      windowId: 'other',
    });
    await fixture.host.receive('owner', {
      ...request(owner, 'version', { type: GlyphWorkbenchCommandType.LIST_CHATS }),
      protocolVersion: 999 as typeof GLYPH_DESKTOP_PROTOCOL_VERSION,
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
});

class HostFixture {
  readonly sent = new Map<string, GlyphHostEventEnvelope[]>();
  readonly runtime = new FakeRuntime();
  readonly factory: GlyphDesktopWorkspaceRuntimeFactory & { create: ReturnType<typeof vi.fn> };
  readonly host: GlyphDesktopHost;

  constructor() {
    const create = vi.fn(async input => {
      this.runtime.emit = input.emit;
      return this.runtime;
    });
    this.factory = { create };
    this.host = new GlyphDesktopHost(this.factory, 'host-generation');
  }

  connect(connectionId: string, identity: GlyphConnectionIdentity): void {
    const events: GlyphHostEventEnvelope[] = [];
    this.sent.set(connectionId, events);
    this.host.connect(connectionId, identity, event => events.push(event));
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
  readonly handle = vi.fn(async (_command: GlyphRuntimeCommand) => {
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
