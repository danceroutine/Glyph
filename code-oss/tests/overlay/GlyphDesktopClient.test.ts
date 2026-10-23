import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphTransportMessageType } from '#glyph/protocol/connection/GlyphTransportMessage.js';
import type { GlyphEditorRequest } from '#glyph/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#glyph/protocol/editor/GlyphEditorResponse.js';
import { GLYPH_DESKTOP_PROTOCOL_VERSION } from '#glyph/protocol/GlyphDesktopProtocolVersion.js';
import { GlyphHostEventType } from '#glyph/protocol/events/GlyphHostEvent.js';
import type { GlyphHostEventEnvelope } from '#glyph/protocol/events/GlyphHostEventEnvelope.js';
import { GlyphHostStatus } from '#glyph/protocol/events/GlyphHostStatus.js';
import { GlyphWorkbenchCommandType, type GlyphWorkbenchCommand } from '#glyph/protocol/GlyphWorkbenchCommand.js';
import { GlyphDesktopClient } from '#vs/workbench/contrib/glyph/electron-browser/GlyphDesktopClient.js';

const transport = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listeners,
    sent: [] as string[],
    acquire: vi.fn<(request: string, response: string) => Promise<unknown>>(),
    exitHost() {
      for (const listener of Array.from(listeners.get('vscode:glyph:hostExited') ?? [])) listener();
    },
  };
});

vi.mock('#vs/base/parts/sandbox/electron-browser/globals.js', () => ({
  ipcRenderer: {
    on(channel: string, listener: () => void) {
      if (!transport.listeners.has(channel)) transport.listeners.set(channel, new Set());
      transport.listeners.get(channel)!.add(listener);
    },
    removeListener(channel: string, listener: () => void) {
      transport.listeners.get(channel)?.delete(listener);
    },
    send(channel: string) {
      transport.sent.push(channel);
    },
  },
}));
vi.mock('#vs/base/parts/ipc/electron-browser/ipc.mp.js', () => ({
  acquirePort: (request: string, response: string) => transport.acquire(request, response),
}));

interface PostedRequest {
  readonly requestId: string;
  readonly command: GlyphWorkbenchCommand & Record<string, unknown>;
}

class FakePort extends EventTarget {
  readonly posted: unknown[] = [];
  closed = false;
  onStart: () => void = () => {};
  onPost: (message: unknown) => void = () => {};
  start(): void {
    this.onStart();
  }
  close(): void {
    this.closed = true;
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
    this.onPost(message);
  }
  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  get requests(): PostedRequest[] {
    return this.posted.filter((message): message is PostedRequest => Boolean((message as PostedRequest).requestId));
  }
}

const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' };
const roots = [{ name: 'project', uri: 'file:///project', canonicalPath: '/project' }];

function host({ generation = 'generation', acknowledge = true } = {}) {
  const port = new FakePort();
  let sequence = 0;
  const envelope = (event: unknown, overrides: Record<string, unknown> = {}) => ({
    ...identity,
    protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION,
    hostGeneration: generation,
    sequence: ++sequence,
    event,
    ...overrides,
  });
  const emit = (event: unknown, overrides: Record<string, unknown> = {}) => {
    port.receive(envelope(event, overrides));
  };
  const acknowledgeRequest = (request: PostedRequest) => {
    if (request.command.type === GlyphWorkbenchCommandType.ATTACH_WORKSPACE)
      emit({ type: GlyphHostEventType.INITIAL_STATE, state: {} });
    emit({ type: GlyphHostEventType.COMMAND_RESULT, requestId: request.requestId, ok: true });
  };
  port.onStart = () => {
    port.receive({ type: GlyphTransportMessageType.READY, identity, hostGeneration: generation });
  };
  if (acknowledge)
    port.onPost = message => {
      if ((message as PostedRequest).requestId)
        queueMicrotask(() => {
          acknowledgeRequest(message as PostedRequest);
        });
    };
  transport.acquire.mockImplementation(async () => port);
  return {
    port,
    emit,
    acknowledgeRequest,
    skip: (count: number) => {
      sequence += count;
    },
    fail: (request: PostedRequest, message: string) => {
      emit({
        type: GlyphHostEventType.ERROR,
        requestId: request.requestId,
        error: { code: 'INTERNAL', message, retryable: false },
      });
    },
  };
}

function client(
  handleEditorRequest = async (_request: GlyphEditorRequest): Promise<GlyphEditorResponse> => {
    throw new Error('No editor requests expected.');
  },
) {
  transport.sent.length = 0;
  transport.acquire.mockReset();
  const instance = new GlyphDesktopClient(handleEditorRequest);
  const events: GlyphHostEventEnvelope[] = [];
  const disconnects: Error[] = [];
  instance.onDidReceiveEvent(event => events.push(event));
  instance.onDidDisconnect(error => disconnects.push(error));
  onTestFinished(() => {
    instance.dispose();
    vi.useRealTimers();
  });
  return { instance, events, disconnects };
}

const openChat = { type: GlyphWorkbenchCommandType.OPEN_CHAT, chatId: 'chat' } as const;

interface ClientInternals {
  readonly identity: unknown;
  readonly connecting: unknown;
  readonly recovering: unknown;
}

function once(condition: () => boolean, action: () => void): void {
  let remaining = 1_000;
  const poll = (): void => {
    if (condition()) action();
    else if (--remaining) queueMicrotask(poll);
  };
  queueMicrotask(poll);
}

describe(GlyphDesktopClient, () => {
  describe(GlyphDesktopClient.prototype.connect, () => {
    it('attaches the workspace through a connection issued by the application', async () => {
      const { instance, events } = client();
      const { port } = host();

      await instance.connect(roots, true);

      expect(transport.acquire).toHaveBeenCalledWith(
        'vscode:glyph:createHostMessageChannel',
        'vscode:glyph:createHostMessageChannelResult',
      );
      expect(port.requests).toEqual([
        {
          ...identity,
          protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION,
          requestId: expect.any(String),
          command: { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true },
        },
      ]);
      expect(events.map(envelope => envelope.event.type)).toEqual([
        GlyphHostEventType.INITIAL_STATE,
        GlyphHostEventType.COMMAND_RESULT,
      ]);
    });

    it('shares one attempt between concurrent callers', async () => {
      const { instance } = client();
      const { port } = host();

      const first = instance.connect(roots, true);
      const second = instance.connect(roots, true);
      await Promise.all([first, second]);

      expect(second).toBe(first);
      expect(transport.acquire).toHaveBeenCalledTimes(1);
      expect(port.requests).toHaveLength(1);
    });

    it('does not reattach an unchanged acknowledged workspace', async () => {
      const { instance } = client();
      const { port } = host();
      await instance.connect(roots, true);

      await instance.connect([...roots], true);

      expect(port.requests).toHaveLength(1);
    });

    it('reattaches from the last applied event when the roots or trust change', async () => {
      const { instance } = client();
      const { port } = host();
      const otherRoots = [{ name: 'other', uri: 'file:///other', canonicalPath: '/other' }];
      await instance.connect(roots, true);

      await instance.connect(roots, false);
      await instance.connect(otherRoots, false);

      expect(transport.acquire).toHaveBeenCalledTimes(1);
      expect(port.requests.map(request => request.command)).toEqual([
        { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true },
        {
          type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
          roots,
          trusted: false,
          resumeHostGeneration: 'generation',
          resumeAfterSequence: 2,
        },
        {
          type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
          roots: otherRoots,
          trusted: false,
          resumeHostGeneration: 'generation',
          resumeAfterSequence: 4,
        },
      ]);
    });

    it('retries a failed attachment that was superseded with the latest configuration', async () => {
      const { instance, disconnects } = client();
      const fixture = host({ acknowledge: false });
      fixture.port.onPost = message => {
        const request = message as PostedRequest;
        if (fixture.port.requests.length === 1) return;
        queueMicrotask(() => {
          fixture.acknowledgeRequest(request);
        });
      };
      const first = instance.connect(roots, true);
      await vi.waitFor(() => {
        expect(fixture.port.requests).toHaveLength(1);
      });

      const latest = instance.connect(roots, false);
      fixture.fail(fixture.port.requests[0], 'Recovery was invalidated.');
      await Promise.all([first, latest]);

      expect(latest).toBe(first);
      expect(fixture.port.requests.map(request => request.command.trusted)).toEqual([true, false]);
      expect(disconnects).toEqual([]);
    });

    it('disconnects when the current attachment fails', async () => {
      const { instance, disconnects } = client();
      const fixture = host({ acknowledge: false });
      fixture.port.onPost = message => {
        queueMicrotask(() => {
          fixture.fail(message as PostedRequest, 'Denied.');
        });
      };

      await expect(instance.connect(roots, true)).rejects.toThrow('INTERNAL: Denied.');

      expect(disconnects.map(error => error.message)).toEqual(['INTERNAL: Denied.']);
      expect(fixture.port.closed).toBe(true);
    });

    it('disconnects with an error when the attachment cannot be transmitted', async () => {
      const { instance, disconnects } = client();
      const { port } = host({ acknowledge: false });
      port.onPost = () => {
        throw 'uncloneable';
      };

      await expect(instance.connect(roots, true)).rejects.toBe('uncloneable');

      expect(disconnects).toEqual([new Error('uncloneable')]);
    });

    it('rejects an attachment acknowledged by a connection that was retired', async () => {
      const { instance, disconnects } = client();
      const fixture = host({ acknowledge: false });
      fixture.port.onPost = message => {
        queueMicrotask(() => {
          fixture.acknowledgeRequest(message as PostedRequest);
          transport.exitHost();
        });
      };

      await expect(instance.connect(roots, true)).rejects.toThrow('The Glyph host connection was superseded.');

      expect(disconnects.map(error => error.message)).toEqual([
        'The Glyph desktop host exited. The response was interrupted.',
      ]);
    });

    it('abandons a connection issued after it was retired', async () => {
      const { instance } = client();
      const port = new FakePort();
      let issue: (port: FakePort) => void = () => {};
      transport.acquire.mockImplementation(
        () =>
          new Promise(resolve => {
            issue = resolve;
          }),
      );

      const connecting = instance.connect(roots, true);
      await vi.waitFor(() => {
        expect(transport.acquire).toHaveBeenCalled();
      });
      transport.exitHost();
      issue(port);

      await expect(connecting).rejects.toThrow('The Glyph host connection was superseded.');
      expect(port.closed).toBe(true);
      expect(port.posted).toEqual([]);
    });

    it('gives up when the host never becomes ready', async () => {
      vi.useFakeTimers();
      const { instance, disconnects } = client();
      const { port } = host();
      port.onStart = () => {
        port.receive(null);
        port.receive({ type: 'unrelated' });
      };

      const connecting = instance.connect(roots, true);
      const rejection = expect(connecting).rejects.toThrow('The Glyph host connection timed out.');
      await vi.advanceTimersByTimeAsync(10_000);

      await rejection;
      expect(disconnects.map(error => error.message)).toEqual(['The Glyph host connection timed out.']);
      expect(port.closed).toBe(true);
    });

    it('fails when the host exits before it becomes ready', async () => {
      const { instance } = client();
      const { port } = host();
      port.onStart = () => {};

      const connecting = instance.connect(roots, true);
      await vi.waitFor(() => {
        expect(transport.acquire).toHaveBeenCalled();
      });
      await Promise.resolve();
      transport.exitHost();

      await expect(connecting).rejects.toThrow('The Glyph desktop host exited. The response was interrupted.');
      expect(port.posted).toEqual([]);
    });

    it('fails when the host exits as it becomes ready', async () => {
      const { instance } = client();
      const { port } = host();
      port.onStart = () => {
        port.receive({ type: GlyphTransportMessageType.READY, identity, hostGeneration: 'generation' });
        transport.exitHost();
      };

      await expect(instance.connect(roots, true)).rejects.toThrow('The Glyph host disconnected during connection.');
      expect(port.posted).toEqual([]);
    });

    it('fails when the host exits right after it becomes ready', async () => {
      const { instance } = client();
      const { port } = host();
      const internals = instance as unknown as ClientInternals;
      port.onStart = () => {
        port.receive({ type: GlyphTransportMessageType.READY, identity, hostGeneration: 'generation' });
        once(
          () => internals.identity !== undefined,
          () => {
            transport.exitHost();
          },
        );
      };

      await expect(instance.connect(roots, true)).rejects.toThrow('The Glyph desktop host is not connected.');
      expect(port.posted).toEqual([]);
    });

    it('connects afresh after the host exits', async () => {
      const { instance } = client();
      const first = host();
      await instance.connect(roots, true);
      transport.exitHost();
      const second = host();

      await instance.connect(roots, true);

      expect(first.port.closed).toBe(true);
      expect(second.port.requests).toHaveLength(1);
    });
  });

  describe(GlyphDesktopClient.prototype.detachWorkspace, () => {
    it('drains the attached workspace while keeping its connection', async () => {
      const { instance } = client();
      const { port } = host();
      await instance.connect(roots, true);

      await instance.detachWorkspace();

      expect(transport.sent).toEqual(['vscode:glyph:preserveWorkspaceHistory']);
      expect(port.requests.map(request => request.command)).toEqual([
        { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true },
        { type: GlyphWorkbenchCommandType.DETACH },
      ]);
      expect(port.closed).toBe(false);
      await expect(instance.request(openChat)).rejects.toThrow('The Glyph desktop workspace is not attached.');
      await instance.connect(roots, true);
      expect(port.requests.map(request => request.command.type)).toEqual([
        GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        GlyphWorkbenchCommandType.DETACH,
        GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
      ]);
    });

    it('only preserves history while disconnected', async () => {
      const { instance } = client();

      await instance.detachWorkspace();

      expect(transport.sent).toEqual(['vscode:glyph:preserveWorkspaceHistory']);
      expect(transport.acquire).not.toHaveBeenCalled();
    });

    it('waits for a failing connection before detaching', async () => {
      const { instance } = client();
      const fixture = host({ acknowledge: false });
      fixture.port.onPost = message => {
        queueMicrotask(() => {
          fixture.fail(message as PostedRequest, 'Denied.');
        });
      };
      const connecting = instance.connect(roots, true).catch((error: unknown) => error);

      await instance.detachWorkspace();

      expect(await connecting).toEqual(new Error('INTERNAL: Denied.'));
      expect(fixture.port.requests).toHaveLength(1);
    });
  });

  describe(GlyphDesktopClient.prototype.request, () => {
    it('attaches workspaces through the shared connection', async () => {
      const { instance } = client();
      const { port } = host();

      await instance.request({ type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: false });

      expect(port.requests.map(request => request.command)).toEqual([
        { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: false },
      ]);
    });

    it('sends commands once a pending attachment completes', async () => {
      const { instance } = client();
      const { port } = host();
      const connecting = instance.connect(roots, true);

      await instance.request(openChat);
      await connecting;

      expect(port.requests.map(request => request.command.type)).toEqual([
        GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
        GlyphWorkbenchCommandType.OPEN_CHAT,
      ]);
    });

    it('rejects commands before a workspace is attached', async () => {
      const { instance } = client();

      await expect(instance.request(openChat)).rejects.toThrow('The Glyph desktop workspace is not attached.');
    });

    it('rejects with the error the host correlates with the command', async () => {
      const { instance } = client();
      const fixture = host();
      await instance.connect(roots, true);
      fixture.port.onPost = message => {
        queueMicrotask(() => {
          fixture.fail(message as PostedRequest, 'No chat.');
        });
      };

      await expect(instance.request(openChat)).rejects.toThrow('INTERNAL: No chat.');
    });

    it('rejects commands that cannot be transmitted', async () => {
      const { instance } = client();
      const { port } = host();
      await instance.connect(roots, true);
      const failure = new Error('could not be cloned');
      port.onPost = message => {
        if ((message as PostedRequest).command?.type === GlyphWorkbenchCommandType.OPEN_CHAT) throw failure;
      };

      await expect(instance.request(openChat)).rejects.toBe(failure);
    });

    it('rejects pending commands when the host exits', async () => {
      const { instance, disconnects } = client();
      const { port } = host();
      await instance.connect(roots, true);
      port.onPost = () => {};

      const pending = instance.request(openChat);
      transport.exitHost();

      await expect(pending).rejects.toThrow('The Glyph desktop host exited. The response was interrupted.');
      expect(disconnects).toHaveLength(1);
      expect(port.closed).toBe(true);
    });
  });

  describe(GlyphDesktopClient.prototype.dispose, () => {
    it('detaches and closes a live connection', async () => {
      const { instance, disconnects } = client();
      const { port } = host();
      await instance.connect(roots, true);
      port.onPost = () => {};
      const pending = instance.request(openChat);

      instance.dispose();

      await expect(pending).rejects.toThrow('The Glyph desktop host disconnected.');
      expect(port.posted.at(-1)).toEqual({
        ...identity,
        protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION,
        requestId: expect.any(String),
        command: { type: GlyphWorkbenchCommandType.DETACH },
      });
      expect(port.closed).toBe(true);
      transport.exitHost();
      expect(disconnects.map(error => error.message)).toEqual(['The Glyph desktop host disconnected.']);
    });

    it('retires an unconnected client', () => {
      const { instance, disconnects } = client();

      instance.dispose();

      expect(disconnects.map(error => error.message)).toEqual(['The Glyph desktop host disconnected.']);
    });
  });

  describe('host messages', () => {
    it('answers editor requests from the host', async () => {
      const response = { requestId: 'editor', ok: true } as unknown as GlyphEditorResponse;
      const handler = vi.fn(async () => response);
      const { instance } = client(handler);
      const { port } = host();
      await instance.connect(roots, true);
      const request = { requestId: 'editor', type: 'read' } as unknown as GlyphEditorRequest;

      port.receive({ type: GlyphTransportMessageType.EDITOR_REQUEST, request });
      port.receive({ type: GlyphTransportMessageType.EDITOR_REQUEST });

      await vi.waitFor(() => {
        expect(port.posted.at(-1)).toEqual({ type: GlyphTransportMessageType.EDITOR_RESPONSE, response });
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(request);
    });

    it('rejects pending commands on transport errors', async () => {
      const { instance } = client();
      const { port } = host();
      await instance.connect(roots, true);
      port.onPost = () => {};

      const pending = instance.request(openChat);
      port.receive({ type: GlyphTransportMessageType.ERROR, message: 'Malformed request.' });

      await expect(pending).rejects.toThrow('Malformed request.');
    });

    it('rejects pending commands with a default error when a transport error has no message', async () => {
      const { instance } = client();
      const { port } = host();
      await instance.connect(roots, true);
      port.onPost = () => {};

      const pending = instance.request(openChat);
      port.receive({ type: GlyphTransportMessageType.ERROR, message: 7 });

      await expect(pending).rejects.toThrow();
    });

    it('ignores late ready messages, malformed envelopes and events for other identities', async () => {
      const { instance, events } = client();
      const fixture = host();
      await instance.connect(roots, true);
      events.length = 0;

      fixture.port.receive({ type: GlyphTransportMessageType.READY, identity, hostGeneration: 'generation' });
      fixture.port.receive(undefined);
      fixture.port.receive({ protocolVersion: 0, hostGeneration: 'generation', sequence: 3, event: {} });
      fixture.port.receive({ protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION, hostGeneration: 1, sequence: 3 });
      fixture.port.receive({ protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION, hostGeneration: 'g', sequence: '3' });
      fixture.port.receive({ protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION, hostGeneration: 'g', sequence: 3 });
      fixture.emit({ type: GlyphHostEventType.USAGE }, { profileId: 'other' });
      fixture.emit({ type: GlyphHostEventType.USAGE }, { workspaceId: 'other' });
      fixture.emit({ type: GlyphHostEventType.USAGE }, { windowId: 'other' });

      expect(events).toEqual([]);
    });

    it('forwards each applied event once', async () => {
      const { instance, events } = client();
      const fixture = host();
      await instance.connect(roots, true);
      events.length = 0;

      fixture.emit({ type: GlyphHostEventType.USAGE });
      fixture.emit({ type: GlyphHostEventType.USAGE }, { sequence: 3 });

      expect(events).toEqual([expect.objectContaining({ sequence: 3, event: { type: GlyphHostEventType.USAGE } })]);
    });

    it('settles commands acknowledged by events it already applied', async () => {
      const { instance, events } = client();
      const fixture = host({ acknowledge: false });
      fixture.port.onPost = message => {
        queueMicrotask(() => {
          fixture.acknowledgeRequest(message as PostedRequest);
        });
      };
      await instance.connect(roots, true);
      fixture.port.onPost = () => {};
      const pending = instance.request(openChat);
      const request = fixture.port.requests.at(-1)!;
      events.length = 0;

      fixture.emit({ type: GlyphHostEventType.COMMAND_RESULT, requestId: 'unknown', ok: true });
      fixture.emit({ type: GlyphHostEventType.ERROR, error: { code: 'INTERNAL', message: 'Unrelated.' } });
      fixture.emit(
        { type: GlyphHostEventType.COMMAND_RESULT, requestId: request.requestId, ok: true },
        { sequence: 1 },
      );

      await expect(pending).resolves.toBeUndefined();
      expect(events.map(envelope => envelope.event.type)).toEqual([
        GlyphHostEventType.COMMAND_RESULT,
        GlyphHostEventType.ERROR,
      ]);
    });

    it('requires a fresh attachment after the workspace owner disconnects', async () => {
      const { instance, disconnects } = client();
      const fixture = host();
      await instance.connect(roots, true);
      fixture.port.onPost = () => {};
      const first = instance.request(openChat);

      fixture.emit({
        type: GlyphHostEventType.HOST_STATUS,
        status: GlyphHostStatus.DISCONNECTED,
        message: 'Detached.',
      });

      await expect(first).rejects.toThrow('Detached.');
      await expect(instance.request(openChat)).rejects.toThrow('The Glyph desktop workspace is not attached.');
      expect(disconnects).toEqual([]);
      expect(fixture.port.closed).toBe(false);
    });

    it('explains an owner disconnect without a message', async () => {
      const { instance } = client();
      const fixture = host();
      await instance.connect(roots, true);
      fixture.port.onPost = () => {};
      const pending = instance.request(openChat);

      fixture.emit({ type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.DISCONNECTED });

      await expect(pending).rejects.toThrow('The workspace owner disconnected.');
    });

    it('keeps the attachment when the host reports other statuses', async () => {
      const { instance, events } = client();
      const fixture = host();
      await instance.connect(roots, true);

      fixture.emit({ type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.READY });

      await expect(instance.request(openChat)).resolves.toBeUndefined();
      expect(events.some(envelope => envelope.event.type === GlyphHostEventType.HOST_STATUS)).toBe(true);
    });

    it('reattaches once from the last applied event after missing events', async () => {
      const { instance, events } = client();
      const fixture = host();
      await instance.connect(roots, true);
      events.length = 0;

      fixture.skip(1);
      fixture.emit({ type: GlyphHostEventType.USAGE });
      fixture.emit({ type: GlyphHostEventType.USAGE });
      await vi.waitFor(() => {
        expect(events.map(envelope => envelope.event.type)).toContain(GlyphHostEventType.COMMAND_RESULT);
      });

      expect(fixture.port.requests.map(request => request.command)).toEqual([
        { type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE, roots, trusted: true },
        {
          type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
          roots,
          trusted: true,
          resumeHostGeneration: 'generation',
          resumeAfterSequence: 2,
        },
      ]);
      await expect(instance.request(openChat)).resolves.toBeUndefined();
    });

    it('does not start another recovery while one is settling', async () => {
      const { instance } = client();
      const fixture = host();
      const internals = instance as unknown as ClientInternals;
      await instance.connect(roots, true);
      let settling = false;

      fixture.emit({ type: GlyphHostEventType.USAGE }, { sequence: 0 });
      once(
        () => internals.connecting === undefined && internals.recovering !== undefined,
        () => {
          settling = true;
          fixture.emit({ type: GlyphHostEventType.USAGE }, { sequence: 0 });
        },
      );
      await vi.waitFor(() => {
        expect(internals.recovering).toBeUndefined();
      });

      expect(settling).toBe(true);
      expect(fixture.port.requests).toHaveLength(2);
    });

    it('defers recovery while it is attaching', async () => {
      const { instance } = client();
      const fixture = host({ acknowledge: false });
      fixture.port.onPost = message => {
        queueMicrotask(() => {
          fixture.emit({ type: GlyphHostEventType.USAGE });
          fixture.acknowledgeRequest(message as PostedRequest);
        });
      };

      await instance.connect(roots, true);

      expect(fixture.port.requests).toHaveLength(1);
    });

    it('rejects pending commands when recovery fails', async () => {
      const { instance, disconnects } = client();
      const fixture = host();
      await instance.connect(roots, true);
      fixture.port.onPost = message => {
        const request = message as PostedRequest;
        if (request.command?.type === GlyphWorkbenchCommandType.ATTACH_WORKSPACE)
          queueMicrotask(() => {
            fixture.fail(request, 'Recovery denied.');
          });
      };
      const pending = instance.request(openChat);

      fixture.skip(1);
      fixture.emit({ type: GlyphHostEventType.USAGE });

      await expect(pending).rejects.toThrow('INTERNAL: Recovery denied.');
      expect(disconnects.map(error => error.message)).toEqual(['INTERNAL: Recovery denied.']);
    });

    it('rejects pending commands with an error when recovery cannot be transmitted', async () => {
      const { instance } = client();
      const fixture = host();
      await instance.connect(roots, true);
      fixture.port.onPost = message => {
        if ((message as PostedRequest).command?.type === GlyphWorkbenchCommandType.ATTACH_WORKSPACE)
          throw 'uncloneable';
      };
      const pending = instance.request(openChat).catch((error: unknown) => error);

      fixture.emit({ type: GlyphHostEventType.USAGE }, { sequence: 0 });

      expect(await pending).toEqual(new Error('uncloneable'));
    });

    it('ignores messages from a retired connection', async () => {
      const { instance, events, disconnects } = client();
      const first = host();
      await instance.connect(roots, true);
      transport.exitHost();
      const second = host();
      await instance.connect(roots, true);
      events.length = 0;

      first.emit({ type: GlyphHostEventType.USAGE }, { sequence: 3 });
      first.port.dispatchEvent(new MessageEvent('messageerror'));

      expect(events).toEqual([]);
      expect(disconnects).toHaveLength(1);
      expect(second.port.closed).toBe(false);
    });

    it('disconnects when the host sends an unreadable message', async () => {
      const { instance, disconnects } = client();
      const { port } = host();
      await instance.connect(roots, true);

      port.dispatchEvent(new MessageEvent('messageerror'));

      expect(disconnects.map(error => error.message)).toEqual(['The Glyph host sent an invalid message.']);
      expect(port.closed).toBe(true);
    });
  });
});
