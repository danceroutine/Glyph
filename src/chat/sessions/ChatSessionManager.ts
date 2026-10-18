import { PlanError } from '#src/planning/PlanError.js';
import { planUpdateSchema, type PlanUpdate } from '#src/planning/PlanSchema.js';
import type { GlyphPlan } from '#src/desktop/protocol/events/GlyphPlan.js';
import { randomUUID } from 'node:crypto';
import type { ChatConversation } from '#src/chat/ChatConversation.js';
import type { ChatProviderState } from '#src/chat/ChatProviderState.js';
import type { ProjectContext } from '#src/project/context/ProjectContext.js';
import { ChatSession, toSummary } from './ChatSession.ts';
import type { ChatSessionRecord, ChatSessionSummary, ChatTranscriptTurn } from './ChatSessionRecord.ts';
import type { ChatSessionStore } from './ChatSessionStore.ts';
import type { ChatTitleGenerator } from './ChatTitleGenerator.ts';
import { ExtractiveChatTitleGenerator } from './ExtractiveChatTitleGenerator.ts';
import type { ToolExecutionContext } from '#src/tools/ToolExecutionContext.js';
import { todoItemsSchema, todoUpdateSchema, type TodoUpdate } from '#src/todos/TodoUpdate.js';

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
  private readonly liveSessions = new Map<string, ChatSession>();
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
      .filter(record => !account || (record.accountProvider === account.provider && record.accountId === account.id))
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
    return this.remember(this.instantiate(record.id, conversation));
  }

  open(
    identifier: string,
    createConversation: ConversationFactory,
    assertCanOpen?: (record: ChatSessionRecord) => void,
  ): ChatSession {
    this.requireInitialized();
    const record = this.resolve(identifier);
    // Authorization must run before returning a cached live session; otherwise a
    // caller could bypass account ownership checks after the first open.
    assertCanOpen?.(record);
    const existing = this.liveSessions.get(record.id);
    if (existing) return existing;
    return this.remember(this.instantiate(record.id, createConversation(record)));
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

  /** Commit independently of turn completion so cancellation cannot erase accepted progress. */
  updateTodos(
    chat: NonNullable<ToolExecutionContext['chat']>,
    input: TodoUpdate,
    signal?: AbortSignal,
  ): Promise<ChatSessionSummary> {
    this.requireInitialized();
    const update = todoUpdateSchema.parse(input);
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      const current = this.requireRecord(chat.id);
      if (current.accountProvider !== chat.accountProvider || current.accountId !== chat.accountId)
        throw new Error('Todo updates must belong to the requesting chat account.');
      const byId = new Map((update.replace ? [] : (current.todos ?? [])).map(item => [item.id, item]));
      for (const item of update.items) byId.set(item.id, item);
      const todos = todoItemsSchema.parse([...byId.values()]);
      const updated = { ...current, todos, updatedAt: this.now().toISOString() };
      await this.saveWith(chat.id, updated);
      return toSummary(updated);
    });
  }

  setMode(id: string, mode: 'agent' | 'plan'): Promise<ChatSessionSummary> {
    return this.enqueue(async () => {
      if (mode !== 'agent' && mode !== 'plan') throw new PlanError('Unknown conversation mode.');
      const updated = { ...this.requireRecord(id), mode };
      await this.saveWith(id, updated);
      return toSummary(updated);
    });
  }

  updatePlan(
    chat: NonNullable<ToolExecutionContext['chat']>,
    input: PlanUpdate,
    signal?: AbortSignal,
  ): Promise<ChatSessionSummary> {
    const update = planUpdateSchema.parse(input);
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      const current = this.requireRecord(chat.id);
      if (current.accountProvider !== chat.accountProvider || current.accountId !== chat.accountId)
        throw new PlanError('The plan must belong to the requesting chat.');
      const previous = current.plans?.findLast(plan => plan.id === update.id);
      if (update.id && (!previous || previous.revision !== update.expectedRevision))
        throw new PlanError('The plan has changed. Read its current revision before editing.');
      if ((current.plans?.length ?? 0) >= 100)
        throw new PlanError('This chat has reached its saved plan revision limit.');
      const plan: GlyphPlan = {
        id: previous?.id ?? randomUUID(),
        revision: (previous?.revision ?? 0) + 1,
        title: update.title,
        summary: update.summary,
        markdown: update.markdown,
        todos: update.todos,
        agents: previous?.agents ?? [{ chatId: chat.id, role: 'Author' }],
      };
      const updated = { ...current, plans: [...(current.plans ?? []), plan], updatedAt: this.now().toISOString() };
      await this.saveWith(chat.id, updated);
      return toSummary(updated);
    });
  }

  linkPlan(
    chatId: string,
    planId: string,
    targetChatId: string,
    role: 'Builder' | 'Reviewer',
  ): Promise<ChatSessionSummary> {
    return this.enqueue(async () => {
      const current = this.requireRecord(chatId);
      const target = this.requireRecord(targetChatId);
      if (current.accountId !== target.accountId || current.accountProvider !== target.accountProvider)
        throw new PlanError('Linked chats must use the same account.');
      const plan = current.plans?.findLast(value => value.id === planId);
      if (!plan) throw new PlanError('The plan is unavailable.');
      const agents = plan.agents.some(agent => agent.chatId === targetChatId)
        ? plan.agents.map(agent =>
            agent.chatId === targetChatId && agent.role !== 'Author' ? { ...agent, role } : agent,
          )
        : [...plan.agents, { chatId: targetChatId, role }];
      const updated = {
        ...current,
        plans: current.plans!.map(value => (value === plan ? { ...plan, agents } : value)),
      };
      await this.saveWith(chatId, updated);
      return toSummary(updated);
    });
  }

  async dispose(): Promise<void> {
    this.liveSessions.clear();
    await this.store.dispose();
  }

  private remember(session: ChatSession): ChatSession {
    this.liveSessions.set(session.id, session);
    return session;
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
        title: generateTitle ? normalizeGeneratedTitle(title) : title,
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
