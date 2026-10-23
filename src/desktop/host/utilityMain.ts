import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import { DeterministicDesktopRuntimeFactory } from './DeterministicDesktopRuntime.ts';
import { GlyphDesktopHost } from './GlyphDesktopHost.ts';
import { OpenAIDesktopRuntimeFactory } from './OpenAIDesktopRuntimeFactory.ts';
import { ScriptedDesktopTransport } from './ScriptedDesktopTransport.ts';
import { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
import { GlyphTransportMessageType } from '#src/desktop/protocol/connection/GlyphTransportMessage.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';
import { isRecord } from '#src/shared/validators/isRecord.js';

interface ElectronMessageEvent {
  readonly data: unknown;
  readonly ports: readonly ElectronMessagePort[];
}

interface ElectronMessagePort {
  on(event: 'message', listener: (event: ElectronMessageEvent) => void): void;
  on(event: 'close', listener: () => void): void;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

interface UtilityParentPort {
  on(event: 'message', listener: (event: ElectronMessageEvent) => void): void;
}

interface UtilityProcess extends NodeJS.Process {
  readonly parentPort?: UtilityParentPort;
}

const parentPort = (process as UtilityProcess).parentPort;
if (!parentPort) throw new Error('The Glyph desktop host must run as an Electron utility process.');

const editors = new EditorRpcRouter();
const transport =
  process.env.GLYPH_DESKTOP_TEST_RUNTIME === 'scripted'
    ? new ScriptedDesktopTransport(process.env.GLYPH_DESKTOP_TEST_PROVIDER_URL ?? '').fetch
    : undefined;
const production = new OpenAIDesktopRuntimeFactory(editors, transport);
const host = new GlyphDesktopHost(
  process.env.GLYPH_DESKTOP_TEST_RUNTIME === 'deterministic' ? new DeterministicDesktopRuntimeFactory() : production,
);
parentPort.on('message', event => {
  const payload = event.data;
  const port = event.ports[0];
  if (
    !port ||
    !isRecord(payload) ||
    payload.type !== GlyphTransportMessageType.CONNECTION ||
    typeof payload.connectionId !== 'string' ||
    payload.connectionId === '' ||
    !isIdentity(payload.identity)
  ) {
    port?.close();
    return;
  }
  // Electron main supplied this identity from its registered window. The utility
  // host never accepts a renderer-authored identity as authority.
  const connectionId = payload.connectionId;
  const identity = payload.identity;
  host.connect(connectionId, identity, message => {
    port.postMessage(message);
  });
  editors.connect(connectionId, identity, message => {
    port.postMessage(message);
  });
  port.on('message', message => {
    const data = message.data;
    if (isRecord(data) && data.type === GlyphTransportMessageType.EDITOR_RESPONSE && isEditorResponse(data.response)) {
      editors.receive(connectionId, data.response);
      return;
    }
    void host.receive(connectionId, data).catch(error => {
      port.postMessage({
        type: GlyphTransportMessageType.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
  port.on('close', () => {
    editors.disconnect(connectionId);
    void host.disconnect(connectionId);
  });
  port.start();
  port.postMessage({ type: GlyphTransportMessageType.READY, identity, hostGeneration: host.generation });
});

function isIdentity(value: unknown): value is GlyphConnectionIdentity {
  return (
    isRecord(value) &&
    typeof value.profileId === 'string' &&
    typeof value.windowId === 'string' &&
    typeof value.workspaceId === 'string'
  );
}

function isEditorResponse(value: unknown): value is GlyphEditorResponse {
  return isRecord(value) && typeof value.operationId === 'string' && typeof value.ok === 'boolean';
}

async function shutdown(): Promise<void> {
  try {
    await host.dispose();
  } finally {
    await production.dispose();
  }
}

process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
