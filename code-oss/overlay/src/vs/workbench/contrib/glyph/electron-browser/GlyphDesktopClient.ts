import { Emitter, type Event } from '#vs/base/common/event.js';
import { Disposable } from '#vs/base/common/lifecycle.js';
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
  private recovering: Promise<void> | undefined;
  private readonly eventEmitter = this._register(new Emitter<GlyphHostEventEnvelope>());
  readonly onDidReceiveEvent: Event<GlyphHostEventEnvelope> = this.eventEmitter.event;
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private port: MessagePort | undefined;
  private identity: GlyphConnectionIdentity | undefined;
  private connecting: Promise<void> | undefined;

  constructor(private readonly handleEditorRequest: (request: GlyphEditorRequest) => Promise<GlyphEditorResponse>) {
    super();
  }

  /** Reuses one connection attempt so concurrent view actions cannot create competing ports. */
  connect(roots: readonly GlyphWorkspaceRoot[], trusted: boolean): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.port && this.identity) return Promise.resolve();
    return (this.connecting = this.connectNow(roots, trusted)
      .catch(error => {
        this.port?.close();
        this.port = undefined;
        this.identity = undefined;
        this.failPending(error instanceof Error ? error : new Error(String(error)));
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      }));
  }

  /** Resolves only after the host acknowledges the request id or returns its correlated error. */
  async request(command: GlyphWorkbenchCommand): Promise<void> {
    const port = this.port;
    const identity = this.identity;
    if (!port || !identity) throw new Error('The Glyph desktop host is not connected.');
    if (command.type === GlyphWorkbenchCommandType.ATTACH_WORKSPACE) this.attachment = command;
    const requestId = generateUuid();
    const envelope: GlyphRequestEnvelope = {
      ...identity,
      protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION,
      requestId,
      command,
    };
    const completed = new Promise<void>((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    port.postMessage(envelope);
    return completed;
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
    this.failPending(new Error('The Glyph desktop host disconnected.'));
    this.port = undefined;
    this.identity = undefined;
    super.dispose();
  }

  private async connectNow(roots: readonly GlyphWorkspaceRoot[], trusted: boolean): Promise<void> {
    const port = await acquirePort(
      'vscode:glyph:createHostMessageChannel',
      'vscode:glyph:createHostMessageChannelResult',
    );
    this.port = port;
    // A late message from a retired port must not rewind a new host generation.
    port.addEventListener('message', event => {
      if (this.port === port) this.receive(event.data);
    });
    port.addEventListener('messageerror', () => this.failPending(new Error('The Glyph host sent an invalid message.')));
    const ready = await new Promise<ReadyMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The Glyph host connection timed out.')), 10_000);
      const listener = (event: MessageEvent) => {
        if (!isReadyMessage(event.data)) return;
        clearTimeout(timeout);
        port.removeEventListener('message', listener);
        resolve(event.data);
      };
      port.addEventListener('message', listener);
      port.start();
    });
    this.identity = ready.identity;
    this.cursor.bind(ready.hostGeneration);
    await this.request({ type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted, ...this.cursor.resume });
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
    if (disposition === GlyphHostEventDisposition.APPLY) this.eventEmitter.fire(value);
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
