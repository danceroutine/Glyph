import { randomUUID } from 'node:crypto';
import type { ChatConversation } from '../ChatConversation.ts';
import type { ChatProviderState } from '../ChatProviderState.ts';
import type { ProjectContext } from '../../project/context/ProjectContext.ts';
import { ChatSession, toSummary } from './ChatSession.ts';
import type { ChatSessionRecord, ChatSessionSummary, ChatTranscriptTurn } from './ChatSessionRecord.ts';
import type { ChatSessionStore } from './ChatSessionStore.ts';
import type { ChatTitleGenerator } from './ChatTitleGenerator.ts';
import { ExtractiveChatTitleGenerator } from './ExtractiveChatTitleGenerator.ts';

export interface CreateChatSessionInput {
  readonly accountProvider: string;
  readonly accountId: string;
  readonly modelSlug: string;
  readonly modelName: string;
}

type ConversationFactory = (record: ChatSessionRecord) => ChatConversation;

/** Project-aware catalog and lifecycle manager for resumable conversations. */
export class ChatSessionManager {
  private records = new Map<string, ChatSessionRecord>();
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly store: ChatSessionStore,
    readonly projectContext: ProjectContext,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    private readonly titles: ChatTitleGenerator = new ExtractiveChatTitleGenerator(),
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.initialize(this.projectContext);
    const records = await this.store.load(this.projectContext.id);
    this.records = new Map(records.map(record => [record.id, record]));
    this.initialized = true;
  }

  list(account?: { provider: string; id: string }): readonly ChatSessionSummary[] {
    this.requireInitialized();
    return [...this.records.values()]
      .filter(
        record =>
          !account || (record.accountProvider === account.provider && record.accountId === account.id),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(toSummary);
  }

  async create(input: CreateChatSessionInput, conversation: ChatConversation): Promise<ChatSession> {
    this.requireInitialized();
    const timestamp = this.now().toISOString();
    const record: ChatSessionRecord = {
      schemaVersion: 3,
      id: this.createId(),
      title: 'New chat',
      titleOrigin: 'placeholder',
      projectContextId: this.projectContext.id,
      accountProvider: input.accountProvider,
      accountId: input.accountId,
      modelSlug: input.modelSlug,
      modelName: input.modelName,
      createdAt: timestamp,
      updatedAt: timestamp,
      providerState: conversation.exportState(),
      transcript: [],
    };
    await this.enqueue(() => this.saveWith(record.id, record));
    return this.instantiate(record.id, conversation);
  }

  open(identifier: string, createConversation: ConversationFactory): ChatSession {
    this.requireInitialized();
    const record = this.resolve(identifier);
    return this.instantiate(record.id, createConversation(record));
  }

  rename(identifier: string, title: string): Promise<ChatSessionSummary> {
    this.requireInitialized();
    const normalized = title.replace(/\s+/gu, ' ').trim();
    if (!normalized) return Promise.reject(new Error('Chat title cannot be empty.'));
    if ([...normalized].length > 80) return Promise.reject(new Error('Chat title may contain at most 80 characters.'));
    const record = this.resolve(identifier);
    return this.enqueue(async () => {
      const updated = {
        ...this.requireRecord(record.id),
        title: normalized,
        titleOrigin: 'human' as const,
        updatedAt: this.now().toISOString(),
      };
      await this.saveWith(record.id, updated);
      return toSummary(updated);
    });
  }

  async dispose(): Promise<void> {
    await this.store.dispose();
  }

  private instantiate(id: string, conversation: ChatConversation): ChatSession {
    return new ChatSession(
      () => this.requireRecord(id),
      conversation,
      (providerState, turn, preserveTranscript) => this.checkpoint(id, providerState, turn, preserveTranscript),
    );
  }

  private checkpoint(
    id: string,
    providerState: ChatProviderState,
    turn?: ChatTranscriptTurn,
    preserveTranscript = false,
  ): Promise<void> {
    return this.enqueue(async () => {
      const current = this.requireRecord(id);
      const transcript = turn ? [...current.transcript, turn] : preserveTranscript ? current.transcript : [];
      const generateTitle = current.titleOrigin === 'placeholder' && turn !== undefined;
      const title = generateTitle ? await this.titles.generate(turn.userText) : current.title;
      const updated: ChatSessionRecord = {
        ...current,
        title: normalizeGeneratedTitle(title),
        titleOrigin: generateTitle ? 'generated' : current.titleOrigin,
        updatedAt: this.now().toISOString(),
        providerState,
        transcript,
      };
      await this.saveWith(id, updated);
    });
  }

  private async saveWith(id: string, record: ChatSessionRecord): Promise<void> {
    const records = new Map(this.records);
    records.set(id, record);
    await this.store.save(record);
    this.records = records;
  }

  private resolve(identifier: string): ChatSessionRecord {
    const candidates = [...this.records.values()].filter(
      record => record.id === identifier || record.id.startsWith(identifier),
    );
    if (candidates.length === 0) throw new Error(`No chat in this project matches "${identifier}".`);
    if (candidates.length > 1) throw new Error(`Chat identifier "${identifier}" is ambiguous.`);
    return candidates[0]!;
  }

  private requireRecord(id: string): ChatSessionRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Chat "${id}" no longer exists.`);
    return record;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('Chat sessions have not been initialized.');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

function normalizeGeneratedTitle(title: string): string {
  const normalized = title.replace(/\s+/gu, ' ').trim();
  const words = normalized.split(' ').filter(Boolean).slice(0, 4);
  const characters = [...words.join(' ')];
  return characters.slice(0, 80).join('') || 'New chat';
}
