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
  readonly generation: string;
  private readonly connections = new Map<string, Connection>();
  private readonly sessions = new Map<string, Connection>();
  private readonly runtimes = new Map<string, WorkspaceRuntimeRecord>();
  private readonly runtimeCreations = new Map<string, Promise<WorkspaceRuntimeRecord>>();
  private readonly ownership = new WorkspaceOwnershipRegistry();

  constructor(
    private readonly runtimeFactory: GlyphDesktopWorkspaceRuntimeFactory,
    generation = `urn:uuid:${randomUUID()}`,
  ) {
    this.generation = generation;
  }

  connect(connectionId: string, identity: GlyphConnectionIdentity, send: Exclude<Connection['send'], undefined>): void {
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
      };
      this.sessions.set(key, connection);
    }
    connection.send = send;
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
    if (!connection.attached) return;
    const record = this.runtimes.get(getWorkspaceKey(connection.identity));
    await record?.runtime.connectionLost(connection.identity.windowId);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.runtimeCreations.values());
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
      switch (request.command.type) {
        case GlyphWorkbenchCommandType.ATTACH_WORKSPACE:
          return await this.attach(connection, request.requestId, request.command);
        case GlyphWorkbenchCommandType.REQUEST_SNAPSHOT:
          return [await this.snapshotEvent(connection), toCommandResultGlyphHostEvent(request.requestId)];
        case GlyphWorkbenchCommandType.DETACH:
          await this.detach(connection);
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

  private async attach(
    connection: Connection,
    requestId: string,
    command: Extract<GlyphWorkbenchCommand, { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE }>,
  ): Promise<readonly GlyphHostEvent[]> {
    const ownership = this.ownership.acquire(connection.identity, command.roots);
    const key = getWorkspaceKey(connection.identity);
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
    const snapshot = await this.snapshotEvent(connection);
    connection.canReplay = true;
    return [snapshot, toCommandResultGlyphHostEvent(requestId)];
  }

  private async dispatch(
    connection: Connection,
    requestId: string,
    command: GlyphRuntimeCommand,
  ): Promise<readonly GlyphHostEvent[]> {
    if (!connection.attached || !connection.ready) {
      return [
        toErrorGlyphHostEvent({
          requestId: requestId,
          message: 'Attach a workspace before sending commands.',
          retryable: false,
        }),
      ];
    }
    if (!connection.trusted && command.type === GlyphWorkbenchCommandType.SEND) {
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
      signal: controller.signal,
      emit: event => this.broadcast(getWorkspaceKey(connection.identity), event),
    });
    return [toCommandResultGlyphHostEvent(requestId)];
  }

  private async snapshotEvent(connection: Connection): Promise<GlyphHostEvent> {
    const record = this.runtimes.get(getWorkspaceKey(connection.identity));
    if (!record) throw new Error('The Glyph workspace runtime is unavailable.');
    const state = await record.runtime.snapshot();
    return {
      type: GlyphHostEventType.INITIAL_STATE,
      state: {
        ...state,
        ownerWindowId: record.ownerWindowId,
        readOnly: connection.readOnly,
        sequence: connection.journal.watermark + 1,
      },
    };
  }

  private async detach(connection: Connection): Promise<void> {
    if (!connection.attached) return;
    connection.attached = false;
    connection.ready = false;
    connection.canReplay = false;
    const key = getWorkspaceKey(connection.identity);
    const record = this.runtimes.get(key);
    await record?.runtime.connectionLost(connection.identity.windowId);
    if (!this.ownership.release(connection.identity)) {
      return;
    }
    this.runtimes.delete(key);
    await record?.runtime.dispose();
    for (const peer of this.sessions.values()) {
      if (getWorkspaceKey(peer.identity) !== key) continue;
      peer.attached = false;
      peer.ready = false;
      peer.canReplay = false;
      this.send(peer, {
        type: GlyphHostEventType.HOST_STATUS,
        status: GlyphHostStatus.DISCONNECTED,
        message: 'The owning window detached.',
      });
    }
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
