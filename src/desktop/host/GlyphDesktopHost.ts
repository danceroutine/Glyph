import { randomUUID } from 'node:crypto';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import type { GlyphCommandResultHostEvent } from '#src/desktop/protocol/events/GlyphCommandResultHostEvent.js';
import type { GlyphErrorHostEvent } from '#src/desktop/protocol/events/GlyphErrorHostEvent.js';
import type { GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import type { GlyphRequestEnvelope } from '#src/desktop/protocol/GlyphRequestEnvelope.js';
import type { GlyphWorkbenchCommand } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import type { GlyphWorkspaceRoot } from '#src/desktop/protocol/connection/GlyphWorkspaceRoot.js';
import {
  GLYPH_DESKTOP_PROTOCOL_VERSION,
  isGlyphProtocolVersion,
} from '#src/desktop/protocol/GlyphDesktopProtocolVersion.js';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';
import { GlyphHostEventType } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphHostStatus } from '#src/desktop/protocol/events/GlyphHostStatus.js';
import { GlyphWorkbenchCommandType } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import { HostEventJournal } from './HostEventJournal.ts';
import { RequestDeduplicator } from './RequestDeduplicator.ts';
import { getWorkspaceKey, WorkspaceOwnershipRegistry } from './WorkspaceOwnershipRegistry.ts';

import type { GlyphDesktopWorkspaceRuntime, GlyphRuntimeCommand } from './GlyphDesktopWorkspaceRuntime.ts';
import type { GlyphDesktopWorkspaceRuntimeFactory } from './GlyphDesktopWorkspaceRuntimeFactory.ts';

interface Connection {
  readonly identity: GlyphConnectionIdentity;
  readonly journal: HostEventJournal;
  readonly requests: RequestDeduplicator<readonly GlyphHostEvent[]>;
  send: ((event: ReturnType<HostEventJournal['append']>) => void) | undefined;
  attached: boolean;
  ready: boolean;
  canReplay: boolean;
  trusted: boolean;
  readOnly: boolean;
  roots: readonly GlyphWorkspaceRoot[];
  attachmentQueue: Promise<void>;
  pendingAttachments: number;
}

interface WorkspaceRuntimeRecord {
  readonly runtime: GlyphDesktopWorkspaceRuntime;
  readonly ownerWindowId: string;
}

/**
 * Owns the security and lifecycle boundary between untrusted renderer messages
 * and workspace runtimes. Electron main supplies immutable connection identity;
 * renderer-provided ids are checked against it before any command is dispatched.
 */
export class GlyphDesktopHost {
  private disposed = false;
  readonly generation: string;
  private readonly connections = new Map<string, Connection>();
  private readonly sessions = new Map<string, Connection>();
  private readonly runtimes = new Map<string, WorkspaceRuntimeRecord>();
  private readonly runtimeCreations = new Map<string, Promise<WorkspaceRuntimeRecord>>();
  private readonly runtimeStops = new Map<string, Promise<void>>();
  private readonly ownership = new WorkspaceOwnershipRegistry();
  private readonly disconnectTimers = new Map<Connection, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly runtimeFactory: GlyphDesktopWorkspaceRuntimeFactory,
    generation = `urn:uuid:${randomUUID()}`,
  ) {
    this.generation = generation;
  }

  connect(connectionId: string, identity: GlyphConnectionIdentity, send: Exclude<Connection['send'], undefined>): void {
    if (this.disposed) throw new Error('The Glyph desktop host has stopped.');
    if (this.connections.has(connectionId)) throw new Error(`Connection ${connectionId} is already registered.`);
    const key = connectionKey(identity);
    let connection = this.sessions.get(key);
    if (connection?.send) throw new Error(`Window ${identity.windowId} already has an active Glyph connection.`);
    if (!connection) {
      connection = {
        identity,
        send: undefined,
        journal: new HostEventJournal(this.generation),
        requests: new RequestDeduplicator(),
        attached: false,
        ready: false,
        canReplay: false,
        trusted: false,
        readOnly: true,
        roots: [],
        attachmentQueue: Promise.resolve(),
        pendingAttachments: 0,
      };
      this.sessions.set(key, connection);
    }
    connection.send = send;
    clearTimeout(this.disconnectTimers.get(connection));
    this.disconnectTimers.delete(connection);
    connection.ready = false;
    this.connections.set(connectionId, connection);
  }

  async receive(connectionId: string, request: GlyphRequestEnvelope): Promise<void> {
    const connection = this.requireConnection(connectionId);
    const result = await connection.requests.run(request.requestId, () => this.execute(connection, request));
    for (const event of result) this.send(connection, event);
  }

  async disconnect(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    connection.send = undefined;
    connection.ready = false;
    // Preserve replay across a renderer reload, but never leave authority or
    // background processes owned by a vanished window indefinitely.
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(connection);
      if (connection.send) return;
      this.sessions.delete(connectionKey(connection.identity));
      void this.detach(connection).catch(() => {
        // Keep ownership reserved if cleanup failed; do not grant a second writer.
      });
    }, 30_000);
    timer.unref();
    this.disconnectTimers.set(connection, timer);
    if (!connection.attached) return;
    const record = this.runtimes.get(getWorkspaceKey(connection.identity));
    await record?.runtime.connectionLost(connection.identity.windowId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
    await Promise.allSettled(this.runtimeCreations.values());
    await Promise.allSettled(this.runtimeStops.values());
    const records = [...new Set([...this.runtimes.values()].map(record => record.runtime))];
    this.connections.clear();
    this.sessions.clear();
    this.runtimes.clear();
    const results = await Promise.allSettled(records.map(runtime => runtime.dispose()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(failure => failure.reason),
        'One or more desktop workspace runtimes failed to stop.',
      );
    }
  }

  private async execute(connection: Connection, request: GlyphRequestEnvelope): Promise<readonly GlyphHostEvent[]> {
    const authorityError = this.validateAuthority(connection, request);
    if (authorityError) {
      return [
        toErrorGlyphHostEvent({
          requestId: request.requestId,
          message: authorityError,
          retryable: false,
          code: GlyphDesktopErrorCode.UNAUTHORIZED,
        }),
      ];
    }
    if (!isGlyphProtocolVersion(request.protocolVersion)) {
      return [
        toErrorGlyphHostEvent({
          requestId: request.requestId,
          message: `Glyph desktop protocol ${String(request.protocolVersion)} is incompatible with ${GLYPH_DESKTOP_PROTOCOL_VERSION}.`,
          retryable: false,
          code: GlyphDesktopErrorCode.PROTOCOL_MISMATCH,
        }),
      ];
    }
    try {
      this.assertCurrentConnection(connection);
      switch (request.command.type) {
        case GlyphWorkbenchCommandType.ATTACH_WORKSPACE: {
          const command = request.command;
          return await this.transitionAttachment(connection, () => this.attach(connection, request.requestId, command));
        }
        case GlyphWorkbenchCommandType.REQUEST_SNAPSHOT:
          await this.publishSnapshot(connection);
          return [toCommandResultGlyphHostEvent(request.requestId)];
        case GlyphWorkbenchCommandType.DETACH:
          await this.transitionAttachment(connection, () => this.detach(connection));
          return [toCommandResultGlyphHostEvent(request.requestId)];
        default:
          return await this.dispatch(connection, request.requestId, request.command);
      }
    } catch (error) {
      return [
        toErrorGlyphHostEvent({
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        }),
      ];
    }
  }

  /** Serialize trust/ownership changes even when a transport sends overlapping requests. */
  private async transitionAttachment<T>(connection: Connection, action: () => Promise<T>): Promise<T> {
    connection.pendingAttachments++;
    const run = async (): Promise<T> => {
      this.assertCurrentConnection(connection);
      return action();
    };
    // Start the first transition synchronously so ownership reservations and
    // stop barriers are visible before another window can attach.
    const operation = connection.pendingAttachments === 1 ? run() : connection.attachmentQueue.then(run);
    connection.attachmentQueue = operation.then(
      () => {},
      () => {},
    );
    try {
      return await operation;
    } catch (error) {
      connection.ready = false;
      throw error;
    } finally {
      connection.pendingAttachments--;
    }
  }

  private assertCurrentConnection(connection: Connection): void {
    if (this.disposed || this.sessions.get(connectionKey(connection.identity)) !== connection) {
      throw new Error('The workspace connection has ended. Reconnect before attaching.');
    }
  }

  private async attach(
    connection: Connection,
    requestId: string,
    command: Extract<GlyphWorkbenchCommand, { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE }>,
  ): Promise<readonly GlyphHostEvent[]> {
    const key = getWorkspaceKey(connection.identity);
    if (command.trusted !== connection.trusted && !connection.readOnly && connection.attached) {
      // Trust changes are lifecycle boundaries. Revocation drains tools; a
      // grant must reconcile deferred reviews before authorizing new mutations.
      connection.trusted = false;
      await this.detach(connection, { notifyOwner: false });
    }
    // New authority cannot overlap a previous owner's asynchronous shutdown.
    const stopping = this.runtimeStops.get(key);
    if (stopping) await stopping;
    this.assertCurrentConnection(connection);
    const ownership = this.ownership.acquire(connection.identity, command.roots);
    let record = this.runtimes.get(key);
    if (!record) {
      let creating = this.runtimeCreations.get(key);
      if (!creating) {
        // Factory initialization includes async persistence/native setup. Peers
        // must await the owner's runtime instead of creating a second writer.
        creating = this.runtimeFactory
          .create({
            identity: connection.identity,
            roots: command.roots,
            trusted: command.trusted,
            emit: event => this.broadcast(key, event),
          })
          .then(runtime => {
            const created = { runtime, ownerWindowId: ownership.ownerWindowId };
            this.runtimes.set(key, created);
            return created;
          })
          .catch(error => {
            this.ownership.release(connection.identity);
            throw error;
          })
          .finally(() => this.runtimeCreations.delete(key));
        this.runtimeCreations.set(key, creating);
      }
      record = await creating;
    }
    this.assertCurrentConnection(connection);
    if (this.runtimeStops.has(key)) throw new Error('The owning window disconnected during workspace initialization.');
    connection.attached = true;
    connection.ready = true;
    connection.trusted = command.trusted;
    connection.readOnly = ownership.readOnly;
    connection.roots = command.roots;
    const replay =
      connection.canReplay &&
      command.resumeHostGeneration === this.generation &&
      command.resumeAfterSequence !== undefined
        ? connection.journal.after(command.resumeAfterSequence)
        : undefined;
    if (replay && replay.length > 0) {
      for (const event of replay) connection.send?.(event);
      return [toCommandResultGlyphHostEvent(requestId)];
    }
    await this.publishSnapshot(connection);
    connection.canReplay = true;
    return [toCommandResultGlyphHostEvent(requestId)];
  }

  private async dispatch(
    connection: Connection,
    requestId: string,
    command: GlyphRuntimeCommand,
  ): Promise<readonly GlyphHostEvent[]> {
    if (!connection.attached || !connection.ready || connection.pendingAttachments > 0) {
      return [
        toErrorGlyphHostEvent({
          requestId: requestId,
          message: 'Attach a workspace before sending commands.',
          retryable: false,
        }),
      ];
    }
    if (!connection.trusted && isMutationCommand(command)) {
      return [
        toErrorGlyphHostEvent({
          requestId: requestId,
          message: 'Workspace trust is required before sending project context.',
          retryable: false,
          code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
        }),
      ];
    }
    if (connection.readOnly && isMutationCommand(command)) {
      return [
        toErrorGlyphHostEvent({
          requestId: requestId,
          message: `Window ${this.ownership.getOwnerWindowId(connection.identity) ?? 'unknown'} owns this workspace's Glyph session.`,
          retryable: true,
          code: GlyphDesktopErrorCode.WORKSPACE_BUSY,
        }),
      ];
    }
    const record = this.runtimes.get(getWorkspaceKey(connection.identity));
    if (!record)
      return [
        toErrorGlyphHostEvent({
          requestId: requestId,
          message: 'The Glyph workspace runtime is unavailable.',
          retryable: true,
          code: GlyphDesktopErrorCode.HOST_UNAVAILABLE,
        }),
      ];
    const controller = new AbortController();
    await record.runtime.handle(command, {
      windowId: connection.identity.windowId,
      signal: controller.signal,
      emit: event => this.broadcast(getWorkspaceKey(connection.identity), event),
    });
    return [toCommandResultGlyphHostEvent(requestId)];
  }

  private async publishSnapshot(connection: Connection): Promise<void> {
    const record = this.runtimes.get(getWorkspaceKey(connection.identity));
    if (!record) throw new Error('The Glyph workspace runtime is unavailable.');
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = connection.journal.watermark;
      const state = await record.runtime.snapshot();
      this.assertCurrentConnection(connection);
      if (this.runtimes.get(getWorkspaceKey(connection.identity)) !== record || !connection.ready)
        throw new Error('The workspace detached during snapshot capture.');
      if (before !== connection.journal.watermark) continue;
      // Check and sequence synchronously: returning the snapshot through another
      // await would let a newer event overtake it again. Deduplication caches only
      // the acknowledgement, never stale state that could be republished later.
      this.send(connection, {
        type: GlyphHostEventType.INITIAL_STATE,
        state: {
          ...state,
          ownerWindowId: record.ownerWindowId,
          readOnly: connection.readOnly,
          sequence: before + 1,
        },
      });
      return;
    }
    throw new Error('Workspace state changed during snapshot capture. Retry the snapshot request.');
  }

  private async detach(connection: Connection, options: { notifyOwner?: boolean } = {}): Promise<void> {
    const key = getWorkspaceKey(connection.identity);
    const isOwner = this.ownership.getOwnerWindowId(connection.identity) === connection.identity.windowId;
    const pendingStop = this.runtimeStops.get(key);
    if (isOwner && pendingStop) return pendingStop;
    // The reservation can already exist while initialization is still pending.
    if (!connection.attached && !isOwner) return;
    connection.attached = false;
    connection.ready = false;
    connection.canReplay = false;
    const record = this.runtimes.get(key);
    if (!isOwner) {
      await record?.runtime.connectionLost(connection.identity.windowId);
      return;
    }
    for (const peer of this.sessions.values()) {
      if (getWorkspaceKey(peer.identity) !== key) continue;
      peer.attached = false;
      peer.ready = false;
      peer.canReplay = false;
      if (peer === connection && options.notifyOwner === false) continue;
      this.send(peer, {
        type: GlyphHostEventType.HOST_STATUS,
        status: GlyphHostStatus.DISCONNECTED,
        message: 'The owning window detached.',
      });
    }
    const stopping = (async () => {
      // A failed initialization has no runtime to stop and releases its own reservation.
      const initialized = record ?? (await this.runtimeCreations.get(key)?.catch(() => undefined));
      // Disposal revokes managed shells and reviews while active turns drain.
      // Do not wait for a blocked turn before initiating that revocation.
      await Promise.all([
        initialized?.runtime.connectionLost(connection.identity.windowId),
        initialized?.runtime.dispose(),
      ]);
      this.runtimes.delete(key);
      this.ownership.release(connection.identity);
    })();
    this.runtimeStops.set(key, stopping);
    await stopping;
    this.runtimeStops.delete(key);
  }

  private broadcast(key: string, event: GlyphHostEvent): void {
    for (const connection of this.sessions.values()) {
      if (connection.attached && getWorkspaceKey(connection.identity) === key) this.send(connection, event);
    }
  }

  private send(connection: Connection, event: GlyphHostEvent): void {
    const envelope = connection.journal.append(connection.identity, event);
    connection.send?.(envelope);
  }

  private validateAuthority(connection: Connection, request: GlyphRequestEnvelope): string | undefined {
    if (request.profileId !== connection.identity.profileId)
      return 'The request profile does not match its connection.';
    if (request.windowId !== connection.identity.windowId) return 'The request window does not match its connection.';
    if (request.workspaceId !== connection.identity.workspaceId)
      return 'The request workspace does not match its connection.';
    return undefined;
  }

  private requireConnection(connectionId: string): Connection {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error(`Unknown desktop connection: ${connectionId}`);
    return connection;
  }
}

function connectionKey(identity: GlyphConnectionIdentity): string {
  return `${identity.profileId}\0${identity.workspaceId}\0${identity.windowId}`;
}

/** Narrows successful acknowledgements so callers cannot accidentally construct another event shape. */
function toCommandResultGlyphHostEvent(requestId: string): GlyphCommandResultHostEvent {
  return { type: GlyphHostEventType.COMMAND_RESULT, requestId, ok: true };
}

/** Centralizes wire-error defaults while retaining the narrowed error event type. */
function toErrorGlyphHostEvent({
  requestId,
  message,
  retryable,
  code = GlyphDesktopErrorCode.INVALID_REQUEST,
}: {
  readonly requestId: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly code?: GlyphDesktopErrorCode;
}): GlyphErrorHostEvent {
  return { type: GlyphHostEventType.ERROR, requestId, error: { code, message, retryable } };
}

function isMutationCommand(command: GlyphRuntimeCommand): boolean {
  return ![GlyphWorkbenchCommandType.LIST_CHATS, GlyphWorkbenchCommandType.OPEN_CHAT].includes(command.type);
}
