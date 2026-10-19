import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import {
  GlyphTransportMessageType,
  type GlyphTransportMessage,
} from '#src/desktop/protocol/connection/GlyphTransportMessage.js';
import { GlyphEditorRequestType, type GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';

/** Keeps editor capabilities tied to the owning window across MessagePort replacement. */
export class EditorRpcRouter {
  private readonly ports = new Map<string, { connectionId: string; send: (message: GlyphTransportMessage) => void }>();
  private readonly pending = new Map<
    string,
    { connectionId: string; resolve: (response: GlyphEditorResponse) => void; reject: (error: Error) => void }
  >();

  connect(
    connectionId: string,
    identity: GlyphConnectionIdentity,
    send: (message: GlyphTransportMessage) => void,
  ): void {
    this.ports.set(key(identity), { connectionId, send });
  }

  disconnect(connectionId: string): void {
    for (const [identity, port] of this.ports) if (port.connectionId === connectionId) this.ports.delete(identity);
    for (const pending of this.pending.values())
      if (pending.connectionId === connectionId) pending.reject(new Error('The owning editor disconnected.'));
  }

  receive(connectionId: string, response: GlyphEditorResponse): void {
    const pending = this.pending.get(response.operationId);
    if (pending?.connectionId === connectionId) pending.resolve(response);
  }

  request(
    identity: GlyphConnectionIdentity,
    request: GlyphEditorRequest,
    signal?: AbortSignal,
  ): Promise<GlyphEditorResponse> {
    const port = this.ports.get(key(identity));
    if (!port) return Promise.reject(new Error('The owning editor is unavailable.'));
    const operationId =
      request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION ||
      request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION
        ? request.mutation.operationId
        : request.operationId;
    if (this.pending.has(operationId)) return Promise.reject(new Error('This editor operation is already pending.'));
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(operationId);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const abort = () => fail(new Error('The editor operation was cancelled.'));
      const timeout = setTimeout(
        () => fail(new Error('The editor operation timed out; its outcome must be inspected before retrying.')),
        30_000,
      );
      this.pending.set(operationId, {
        connectionId: port.connectionId,
        resolve: response => {
          cleanup();
          resolve(response);
        },
        reject: fail,
      });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        port.send({ type: GlyphTransportMessageType.EDITOR_REQUEST, request });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

function key(identity: GlyphConnectionIdentity): string {
  return JSON.stringify([identity.profileId, identity.workspaceId, identity.windowId]);
}
