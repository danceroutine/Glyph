import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import type { GlyphRequestEnvelope } from '#src/desktop/protocol/GlyphRequestEnvelope.js';
import { DeterministicDesktopRuntimeFactory } from './DeterministicDesktopRuntime.ts';
import { GlyphDesktopHost } from './GlyphDesktopHost.ts';
import { OpenAIDesktopRuntimeFactory } from './OpenAIDesktopRuntimeFactory.ts';
import { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
import {
  GlyphTransportMessageType,
  type GlyphTransportMessage,
} from '#src/desktop/protocol/connection/GlyphTransportMessage.js';

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

interface ConnectionPayload {
  readonly type: GlyphTransportMessageType.CONNECTION;
  readonly connectionId: string;
  readonly identity: GlyphConnectionIdentity;
}

const parentPort = (process as UtilityProcess).parentPort;
if (!parentPort) throw new Error('The Glyph desktop host must run as an Electron utility process.');

const editors = new EditorRpcRouter();
const production = new OpenAIDesktopRuntimeFactory(editors);
const host = new GlyphDesktopHost(
  process.env.GLYPH_DESKTOP_TEST_RUNTIME === 'deterministic' ? new DeterministicDesktopRuntimeFactory() : production,
);
parentPort.on('message', event => {
  const payload = event.data as Partial<ConnectionPayload> | undefined;
  const port = event.ports[0];
  if (
    !port ||
    payload?.type !== GlyphTransportMessageType.CONNECTION ||
    !payload.connectionId ||
    !isIdentity(payload.identity)
  ) {
    port?.close();
    return;
  }
  // Electron main supplied this identity from its registered window. The utility
  // host never accepts a renderer-authored identity as authority.
  const { connectionId, identity } = payload as ConnectionPayload;
  host.connect(connectionId, identity, message => port.postMessage(message));
  editors.connect(connectionId, identity, message => port.postMessage(message));
  port.on('message', message => {
    const control = message.data as
      Partial<Extract<GlyphTransportMessage, { type: GlyphTransportMessageType.EDITOR_RESPONSE }>> | undefined;
    if (control?.type === GlyphTransportMessageType.EDITOR_RESPONSE && control.response) {
      editors.receive(connectionId, control.response);
      return;
    }
    void host.receive(connectionId, message.data as GlyphRequestEnvelope).catch(error => {
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
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GlyphConnectionIdentity>;
  return (
    typeof candidate.profileId === 'string' &&
    typeof candidate.windowId === 'string' &&
    typeof candidate.workspaceId === 'string'
  );
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
