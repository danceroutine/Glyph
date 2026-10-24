import { mkdir, mkdtemp, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphService } from '#src/application/GlyphService.js';
import { OpenAIDesktopRuntimeFactory } from '#src/desktop/host/OpenAIDesktopRuntimeFactory.js';
import type { ProviderDesktopRuntime } from '#src/desktop/host/ProviderDesktopRuntime.js';
import type { DesktopInteractionBroker } from '#src/desktop/host/DesktopInteractionBroker.js';
import { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import type { WebToolRuntime } from '#src/web/WebToolRuntime.js';
const ApprovalDecision = { DENY: 'deny', ALLOW_ONCE: 'allow_once', ALLOW_EVERYTHING: 'allow_everything' } as const;
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';

const captured = vi.hoisted(() => ({
  tools: [] as WebToolRuntime[],
  brokers: [] as DesktopInteractionBroker[],
  events: [] as GlyphHostEvent[],
}));

vi.mock('#src/web/WebToolRuntime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/web/WebToolRuntime.js')>();
  return {
    ...actual,
    WebToolRuntime: class extends actual.WebToolRuntime {
      constructor(...args: ConstructorParameters<typeof actual.WebToolRuntime>) {
        super(...args);
        captured.tools.push(this);
      }
    },
  };
});

vi.mock('#src/desktop/host/DesktopInteractionBroker.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/desktop/host/DesktopInteractionBroker.js')>();
  return {
    ...actual,
    DesktopInteractionBroker: class extends actual.DesktopInteractionBroker {
      constructor(emit: (event: GlyphHostEvent) => void) {
        super(event => {
          captured.events.push(event);
          emit(event);
        });
        captured.brokers.push(this);
      }
    },
  };
});

describe('security: production desktop web consent', () => {
  /**
   * A model can ask the normal desktop factory's web tool to fetch an internal
   * URL. Only its own run's explicit answer may admit that request. Denial and
   * cross-run answers must send no HTTP request. A persisted broad web grant
   * survives reopening but cannot create shell consent or follow changed roots.
   * The HTTP socket is replaced by a recording fetch; this proves host wiring,
   * durable consent and run ownership, not Electron rendering or kernel policy.
   */
  it('binds consent to the requesting run, persists web-only consent and rechecks changed roots', async () => {
    for (const values of Object.values(captured)) values.length = 0;
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-web-consent-')));
    const state = join(directory, 'state');
    const root = join(directory, 'workspace');
    const changedRoot = join(directory, 'changed-workspace');
    await mkdir(root);
    await mkdir(changedRoot);
    vi.stubEnv('GLYPH_CONFIG_DIR', state);
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    vi.spyOn(GlyphService.prototype, 'initialize').mockResolvedValue();
    const exchange = vi.fn(async () => new Response('fixture page', { headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', exchange);
    const factory = new OpenAIDesktopRuntimeFactory(new EditorRpcRouter());
    const runtimes: ProviderDesktopRuntime[] = [];
    onTestFinished(async () => {
      for (const runtime of runtimes) await runtime.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    });
    const open = async (path: string) => {
      runtimes.push(
        await factory.create({
          identity: { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' },
          roots: [{ name: 'workspace', canonicalPath: path, uri: `file://${path}` }],
          trusted: true,
          emit: () => {},
        }),
      );
    };
    const identity = { chatId: 'requesting-chat', runId: 'requesting-run' };
    const invoke = () =>
      captured.brokers
        .at(-1)!
        .run(identity, () =>
          captured.tools
            .at(-1)!
            .tools[0]!.execute(JSON.stringify({ url: 'http://127.0.0.1/private' }), new AbortController().signal, {}),
        );
    const decide = async (decision: (typeof ApprovalDecision)[keyof typeof ApprovalDecision]) => {
      await vi.waitFor(() => {
        expect(captured.events.some(event => event.type === GlyphHostEventType.QUESTION)).toBe(true);
      });
      const event = captured.events.find(event => event.type === GlyphHostEventType.QUESTION)!;
      if (event.type !== GlyphHostEventType.QUESTION) throw new Error('Missing question');
      expect(event).toMatchObject(identity);
      expect(event.question.prompt).toContain('127.0.0.1');
      expect(event.question.prompt).toContain('does not grant shell permission');
      const answer = {
        ...identity,
        id: event.question.id,
        kind: 'question' as const,
        value: { answers: [{ questionId: 'approval', type: QuestionAnswerType.SELECTION, optionIds: [decision] }] },
      };
      expect(() => {
        captured.brokers.at(-1)!.answer({ ...answer, runId: 'other-run' });
      }).toThrow('no longer pending');
      captured.brokers.at(-1)!.answer(answer);
      captured.events.length = 0;
    };
    await open(root);
    const denied = invoke();
    await decide(ApprovalDecision.DENY);
    expect(await denied).toContain('web_error');
    expect(exchange).not.toHaveBeenCalled();
    const once = invoke();
    await decide(ApprovalDecision.ALLOW_ONCE);
    expect(await once).toContain('fixture page');
    const broad = invoke();
    await decide(ApprovalDecision.ALLOW_EVERYTHING);
    expect(await broad).toContain('fixture page');
    expect(exchange).toHaveBeenCalledTimes(2);
    await runtimes.pop()!.dispose();
    await open(root);
    expect(await invoke()).toContain('fixture page');
    expect(captured.events.some(event => event.type === GlyphHostEventType.QUESTION)).toBe(false);
    const files = await readdir(state, { recursive: true });
    expect(files.some(file => file.endsWith('approval-grants.json'))).toBe(true);
    expect(files.some(file => /shell.*permission/u.test(file))).toBe(false);
    await runtimes.pop()!.dispose();
    await open(changedRoot);
    const changed = invoke();
    await decide(ApprovalDecision.DENY);
    expect(await changed).toContain('web_error');
    expect(exchange).toHaveBeenCalledTimes(3);
  });
});
