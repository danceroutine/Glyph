import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import OpenAI from 'openai';
import type { ResponseOutputItem } from 'openai/resources/responses/responses';
import { GlyphService } from '../../GlyphService.ts';
import { ContextAttachmentService } from '../../../context/attachments/ContextAttachmentService.ts';
import type { ChatConversation } from '../../../chat/ChatConversation.ts';
import type { ChatConfiguration } from '../../../configuration/ChatConfiguration.ts';
import { EditProposalService } from '../../../editing/proposals/EditProposalService.ts';
import { ProposalReviewManager } from '../../../editing/reviews/ProposalReviewManager.ts';
import type { EditingConfiguration } from '../../../editing/configuration/EditingConfiguration.ts';
import { FileProposalReviewStore } from '../../../editing/reviews/persistence/FileProposalReviewStore.ts';
import { JsDiffTextDiffer } from '../../../editing/documents/JsDiffTextDiffer.ts';
import { ProjectAccess } from '../../../project/ProjectAccess.ts';
import { ProjectToolRuntime } from '../../../project/ProjectToolRuntime.ts';
import { ProjectAgentInstructions } from '../../../project/prompts/ProjectAgentInstructions.ts';
import { OpenAIProvider } from '../../../providers/openai/OpenAIProvider.ts';
import { FileSystemWorkspaceTextStore } from '../../../workspace/FileSystemWorkspaceTextStore.ts';
import { RecordingLogger } from './RecordingLogger.ts';
import { RecordingResponseStream } from './RecordingResponseStream.ts';
import { ScriptedOpenAIResponsesFixture } from './ScriptedOpenAIResponsesFixture.ts';
import type { ScriptedResponseRound } from './ScriptedResponseRound.ts';
import { DenyNetworkHttpClient } from './DenyNetworkHttpClient.ts';
import { FixtureChatProviderFactory } from './FixtureChatProviderFactory.ts';
import { FixtureModelCatalog } from './FixtureModelCatalog.ts';
import { FixtureOpenAIAccountStore } from './FixtureOpenAIAccountStore.ts';
import { FixtureOpenAISession } from './FixtureOpenAISession.ts';

const chat: ChatConfiguration = { instructions: 'Edit the project when asked.', timeoutMs: 10_000 };
const editing: EditingConfiguration = {
  maxRawProposalBytes: 1_048_576,
  maxChangedBytes: 1_048_576,
  maxResultingBytesPerFile: 1_048_576,
  maxFiles: 64,
  maxTotalHunks: 256,
  maxHunksPerFile: 64,
  diffBudgetMs: 1_000,
  maxActiveReviews: 1,
  newFileByteOrderMark: false,
  newFileLineEnding: '\n',
};

export class EditingE2EHarness {
  readonly logger = new RecordingLogger();
  readonly workspace: FileSystemWorkspaceTextStore;
  readonly reviews: ProposalReviewManager;
  readonly fixture: ScriptedOpenAIResponsesFixture;
  readonly provider: OpenAIProvider;
  readonly http = new DenyNetworkHttpClient();
  readonly application: GlyphService;
  private readonly conversation: ChatConversation;

  private constructor(
    readonly projectRoot: string,
    readonly stateRoot: string,
    rounds: readonly ScriptedResponseRound[],
  ) {
    this.workspace = new FileSystemWorkspaceTextStore(projectRoot);
    this.reviews = new ProposalReviewManager(this.workspace, new FileProposalReviewStore(stateRoot), this.logger);
    const proposals = new EditProposalService(
      this.workspace,
      new JsDiffTextDiffer(),
      editing,
      this.logger,
      deterministicIds(),
      () => new Date(0),
    );
    const runtime = new ProjectToolRuntime(
      new ProjectAccess(projectRoot, {}, this.workspace),
      proposals,
      this.reviews,
      this.logger,
    );
    this.fixture = new ScriptedOpenAIResponsesFixture(rounds);
    const client = new OpenAI({
      apiKey: 'sentinel-not-a-real-token',
      baseURL: 'https://responses.fixture.invalid/v1',
      maxRetries: 0,
      fetch: this.fixture.fetch,
    });
    this.provider = new OpenAIProvider(
      'test-model',
      { ...chat, instructions: new ProjectAgentInstructions(chat.instructions).render() },
      async () => 'sentinel-not-a-real-token',
      client,
      runtime,
    );
    const accountStore = new FixtureOpenAIAccountStore();
    this.application = new GlyphService(
      accountStore,
      new FixtureOpenAISession(accountStore.state.accounts[0]!),
      new FixtureModelCatalog(),
      new FixtureChatProviderFactory(this.provider),
      this.logger,
      {
        issuer: 'https://auth.fixture.invalid',
        resource: 'https://responses.fixture.invalid/v1',
        scopes: 'openid chatgpt.tokens.use.direct',
        planScope: 'chatgpt.tokens.use.direct',
        requestTimeoutMs: 1_000,
      },
      { traceEnabled: true },
      this.reviews,
      new ContextAttachmentService(this.workspace),
    );
    this.conversation = this.application.createConversation(accountStore.state.accounts[0]!, {
      slug: 'test-model',
      name: 'Test Model',
    });
  }

  static async create(
    files: Record<string, string | Uint8Array>,
    rounds: readonly ScriptedResponseRound[],
  ): Promise<EditingE2EHarness> {
    const project = await mkdtemp(join(tmpdir(), 'editing-e2e-project-'));
    const state = await mkdtemp(join(tmpdir(), 'editing-e2e-state-'));
    for (const [path, value] of Object.entries(files)) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), value);
    }
    const harness = new EditingE2EHarness(project, state, rounds);
    await harness.application.initialize();
    return harness;
  }

  async send(prompt = 'Make the requested edit.', attachmentPaths: readonly string[] = []): Promise<string> {
    return this.sendWithSignal(new AbortController().signal, prompt, attachmentPaths);
  }

  async sendWithSignal(
    signal: AbortSignal,
    prompt = 'Make the requested edit.',
    attachmentPaths: readonly string[] = [],
  ): Promise<string> {
    const response = new RecordingResponseStream();
    const request = await this.application.resolveChatRequest(
      prompt,
      attachmentPaths.map(path => ({ path })),
    );
    await this.conversation.send(request, response, signal);
    return response.text;
  }

  async dispose(): Promise<void> {
    this.fixture.assertConsumed();
    if (this.http.attempts !== 0) throw new Error(`Unexpected HTTP attempts: ${this.http.attempts}`);
    await this.application.dispose();
    await rm(this.projectRoot, { recursive: true, force: true });
    await rm(this.stateRoot, { recursive: true, force: true });
  }

  static finalMessage(text = 'The edit is staged for your review.'): ResponseOutputItem {
    return {
      type: 'message',
      id: 'message-final',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    } satisfies ResponseOutputItem;
  }
}

function deterministicIds(): () => string {
  let id = 0;
  return () => `fixture-id-${++id}`;
}
