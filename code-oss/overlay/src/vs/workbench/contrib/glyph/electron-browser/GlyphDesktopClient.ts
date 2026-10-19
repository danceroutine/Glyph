import { Emitter, type Event } from '#vs/base/common/event.js';
import { Disposable, toDisposable } from '#vs/base/common/lifecycle.js';
import { ipcRenderer } from '#vs/base/parts/sandbox/electron-browser/globals.js';
import { generateUuid } from '#vs/base/common/uuid.js';
import {
  GlyphTransportMessageType,
  type GlyphTransportMessage,
} from '#glyph/protocol/connection/GlyphTransportMessage.js';
import type { GlyphEditorRequest } from '#glyph/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#glyph/protocol/editor/GlyphEditorResponse.js';
import { acquirePort } from '#vs/base/parts/ipc/electron-browser/ipc.mp.js';
import { GLYPH_DESKTOP_PROTOCOL_VERSION } from '#glyph/protocol/GlyphDesktopProtocolVersion.js';
import { GlyphHostEventType } from '#glyph/protocol/events/GlyphHostEvent.js';
import { GlyphHostStatus } from '#glyph/protocol/events/GlyphHostStatus.js';
import { GlyphWorkbenchCommandType } from '#glyph/protocol/GlyphWorkbenchCommand.js';
import type { GlyphConnectionIdentity } from '#glyph/protocol/connection/GlyphConnectionIdentity.js';
import type { GlyphHostEventEnvelope } from '#glyph/protocol/events/GlyphHostEventEnvelope.js';
import type { GlyphRequestEnvelope } from '#glyph/protocol/GlyphRequestEnvelope.js';
import type { GlyphWorkbenchCommand } from '#glyph/protocol/GlyphWorkbenchCommand.js';
import type { GlyphWorkspaceRoot } from '#glyph/protocol/connection/GlyphWorkspaceRoot.js';
import { GlyphHostEventCursor, GlyphHostEventDisposition } from '#glyph/workbench/GlyphHostEventCursor.js';

interface ReadyMessage {
  readonly type: GlyphTransportMessageType.READY;
  readonly identity: GlyphConnectionIdentity;
  readonly hostGeneration: string;
}

/**
 * Owns the renderer end of the application-issued MessagePort. Electron main,
 * not renderer input, assigns connection identity before requests are allowed.
 */
export class GlyphDesktopClient extends Disposable {
  private readonly cursor = new GlyphHostEventCursor();
  private attachment: Extract<GlyphWorkbenchCommand, { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE }> | undefined;
  private appliedAttachment: typeof this.attachment;
  private recovering: Promise<void> | undefined;
  private readonly eventEmitter = this._register(new Emitter<GlyphHostEventEnvelope>());
  readonly onDidReceiveEvent: Event<GlyphHostEventEnvelope> = this.eventEmitter.event;
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private port: MessagePort | undefined;
  private identity: GlyphConnectionIdentity | undefined;
  private connecting: Promise<void> | undefined;
  private attached = false;
  private readonly disconnectEmitter = this._register(new Emitter<Error>());
  readonly onDidDisconnect = this.disconnectEmitter.event;
  private connectionEpoch = 0;
  private cancelHandshake: ((error: Error) => void) | undefined;

  constructor(private readonly handleEditorRequest: (request: GlyphEditorRequest) => Promise<GlyphEditorResponse>) {
    super();
    const hostExited = (): void =>
      this.disconnect(new Error('The Glyph desktop host exited. The response was interrupted.'));
    ipcRenderer.on('vscode:glyph:hostExited', hostExited);
    this._register(toDisposable(() => ipcRenderer.removeListener('vscode:glyph:hostExited', hostExited)));
  }

  /** Reuses one connection attempt so concurrent view actions cannot create competing ports. */
  connect(roots: readonly GlyphWorkspaceRoot[], trusted: boolean): Promise<void> {
    // Record authority changes even while port acquisition or an older attach
    // is pending. Only the last acknowledged configuration permits commands.
    if (
      !this.attachment ||
      this.attachment.trusted !== trusted ||
      JSON.stringify(this.attachment.roots) !== JSON.stringify(roots)
    ) {
      this.attachment = { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted };
    }
    if (this.connecting) return this.connecting;
    if (this.port && this.identity && this.attached && this.appliedAttachment === this.attachment)
      return Promise.resolve();
    const epoch = this.connectionEpoch;
    const connect = Promise.resolve().then(async () => {
      if (!this.port || !this.identity) await this.connectNow(epoch);
      do {
        const attachment = this.attachment!;
        try {
          await this.postRequest({ ...attachment, ...this.cursor.resume });
        } catch (error) {
          // Revoking trust may invalidate recovery reads in the older attach.
          // Its failure does not reject the newer authority configuration queued
          // on this same live port; keep all callers waiting for that attempt.
          if (epoch === this.connectionEpoch && attachment !== this.attachment) continue;
          throw error;
        }
        if (epoch !== this.connectionEpoch) throw new Error('The Glyph host connection was superseded.');
        this.appliedAttachment = attachment;
        this.attached = true;
      } while (this.appliedAttachment !== this.attachment);
    });
    return (this.connecting = connect
      .catch(error => {
        if (epoch === this.connectionEpoch) this.disconnect(error instanceof Error ? error : new Error(String(error)));
        throw error;
      })
      .finally(() => {
        if (epoch === this.connectionEpoch) this.connecting = undefined;
      }));
  }

  /** Resolves only after the host acknowledges the request id or returns its correlated error. */
  async request(command: GlyphWorkbenchCommand): Promise<void> {
    if (command.type === GlyphWorkbenchCommandType.ATTACH_WORKSPACE)
      return this.connect(command.roots, command.trusted);
    // Initial snapshots may arrive before attach acknowledgement. They are UI
    // state, not authorization to bypass a pending trust synchronization.
    while (this.connecting) await this.connecting;
    if (!this.attached) throw new Error('The Glyph desktop workspace is not attached.');
    return this.postRequest(command);
  }

  override dispose(): void {
    const port = this.port;
    if (port && this.identity) {
      const envelope: GlyphRequestEnvelope = {
        ...this.identity,
        protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION,
        requestId: generateUuid(),
        command: { type: GlyphWorkbenchCommandType.DETACH },
      };
      port.postMessage(envelope);
      port.close();
    }
    this.disconnect(new Error('The Glyph desktop host disconnected.'));
    super.dispose();
  }

  private async postRequest(command: GlyphWorkbenchCommand): Promise<void> {
    const port = this.port;
    const identity = this.identity;
    if (!port || !identity) throw new Error('The Glyph desktop host is not connected.');
    const requestId = generateUuid();
    const envelope: GlyphRequestEnvelope = {
      ...identity,
      protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION,
      requestId,
      command,
    };
    const completed = new Promise<void>((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    try {
      port.postMessage(envelope);
    } catch (error) {
      this.pending.delete(requestId);
      return Promise.reject(error);
    }
    return completed;
  }

  private async connectNow(epoch: number): Promise<void> {
    const port = await acquirePort(
      'vscode:glyph:createHostMessageChannel',
      'vscode:glyph:createHostMessageChannelResult',
    );
    if (epoch !== this.connectionEpoch) {
      port.close();
      throw new Error('The Glyph host connection was superseded.');
    }
    this.port = port;
    // A late message from a retired port must not rewind a new host generation.
    port.addEventListener('message', event => {
      if (this.port === port) this.receive(event.data);
    });
    port.addEventListener('messageerror', () => {
      if (this.port === port) this.disconnect(new Error('The Glyph host sent an invalid message.'));
    });
    const ready = await new Promise<ReadyMessage>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        port.removeEventListener('message', listener);
        this.cancelHandshake = undefined;
      };
      const cancel = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(() => cancel(new Error('The Glyph host connection timed out.')), 10_000);
      const listener = (event: MessageEvent) => {
        if (!isReadyMessage(event.data)) return;
        cleanup();
        resolve(event.data);
      };
      this.cancelHandshake = cancel;
      port.addEventListener('message', listener);
      port.start();
    });
    if (epoch !== this.connectionEpoch) throw new Error('The Glyph host disconnected during connection.');
    this.identity = ready.identity;
    this.cursor.bind(ready.hostGeneration);
  }

  private receive(value: unknown): void {
    if (isReadyMessage(value)) return;
    const control = value as Partial<GlyphTransportMessage> | undefined;
    if (control?.type === GlyphTransportMessageType.EDITOR_REQUEST && control.request) {
      const port = this.port;
      void this.handleEditorRequest(control.request).then(response =>
        port?.postMessage({ type: GlyphTransportMessageType.EDITOR_RESPONSE, response }),
      );
      return;
    }
    if (control?.type === GlyphTransportMessageType.ERROR) {
      this.failPending(new Error(control.message));
      return;
    }
    if (!isHostEventEnvelope(value)) return;
    if (!this.matchesIdentity(value)) return;
    const disposition = this.cursor.accept(value);
    if (disposition === GlyphHostEventDisposition.APPLY) {
      if (value.event.type === GlyphHostEventType.INITIAL_STATE) this.attached = true;
      if (value.event.type === GlyphHostEventType.HOST_STATUS && value.event.status === GlyphHostStatus.DISCONNECTED) {
        this.attached = false;
        // The utility process is alive, but this workspace lost its owner.
        // Retain the transport and require a fresh attach before the next action.
        this.failPending(new Error(value.event.message ?? 'The workspace owner disconnected.'));
      }
      this.eventEmitter.fire(value);
    }
    if (disposition === GlyphHostEventDisposition.RECOVER && !this.connecting) this.recover();
    // A snapshot can supersede an acknowledgement's sequence without completing
    // its promise. Settle correlated results independently of projection deduplication.
    if (value.event.type === GlyphHostEventType.COMMAND_RESULT) {
      const pending = this.pending.get(value.event.requestId);
      this.pending.delete(value.event.requestId);
      pending?.resolve();
    } else if (value.event.type === GlyphHostEventType.ERROR && value.event.requestId) {
      const pending = this.pending.get(value.event.requestId);
      this.pending.delete(value.event.requestId);
      pending?.reject(new Error(`${value.event.error.code}: ${value.event.error.message}`));
    }
  }

  /** Reattach with the last applied sequence; the host falls back to a snapshot if replay aged out. */
  private recover(): void {
    if (this.recovering || !this.attachment) return;
    const { roots, trusted } = this.attachment;
    this.appliedAttachment = undefined;
    this.recovering = this.request({
      type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      roots,
      trusted,
      ...this.cursor.resume,
    })
      .catch(error => {
        // Do not leave callers waiting forever when recovery itself is rejected.
        this.failPending(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.recovering = undefined;
      });
  }

  private matchesIdentity(envelope: GlyphHostEventEnvelope): boolean {
    return (
      envelope.profileId === this.identity?.profileId &&
      envelope.workspaceId === this.identity?.workspaceId &&
      envelope.windowId === this.identity?.windowId
    );
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** Retire all state tied to a dead port; a later user action can connect afresh. */
  private disconnect(error: Error): void {
    this.connectionEpoch++;
    this.cancelHandshake?.(error);
    this.port?.close();
    this.port = undefined;
    this.identity = undefined;
    this.connecting = undefined;
    this.attached = false;
    this.appliedAttachment = undefined;
    this.recovering = undefined;
    this.failPending(error);
    this.disconnectEmitter.fire(error);
  }
}

function isReadyMessage(value: unknown): value is ReadyMessage {
  return Boolean(
    value && typeof value === 'object' && (value as Partial<ReadyMessage>).type === GlyphTransportMessageType.READY,
  );
}

function isHostEventEnvelope(value: unknown): value is GlyphHostEventEnvelope {
  const candidate = value as Partial<GlyphHostEventEnvelope> | undefined;
  return Boolean(
    candidate &&
    candidate.protocolVersion === GLYPH_DESKTOP_PROTOCOL_VERSION &&
    typeof candidate.hostGeneration === 'string' &&
    typeof candidate.sequence === 'number' &&
    candidate.event,
  );
}
