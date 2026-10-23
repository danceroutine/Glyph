import { AgentMode, AgentModeID } from '#src/chat/AgentMode.js';
import { ChatHistoryError } from './ChatHistoryError.ts';
import { PlanError } from '#src/planning/PlanError.js';
import { planUpdateSchema, type PlanUpdate } from '#src/planning/PlanSchema.js';
import { GlyphPlan } from '#src/planning/GlyphPlan.js';
import type { GlyphPlanRecord } from '#src/desktop/protocol/events/GlyphPlanRecord.js';
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
import { Goal } from '#src/goals/Goal.js';
import { GoalError } from '#src/goals/GoalError.js';
import { chatGoalSchema } from '#src/goals/GoalSchema.js';
import { TodoStatus } from '#src/todos/TodoStatus.js';

type ChatOwner = NonNullable<ToolExecutionContext['chat']>;

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
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(value => toSummary(value));
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

  async branch(session: ChatSession, turnId: string, createConversation: ConversationFactory): Promise<ChatSession> {
    const { record, index, turn } = await session.historyAt(turnId);
    if (!turn.checkpoints) throw new ChatHistoryError('This message has no saved checkpoint.');
    const timestamp = this.now().toISOString();
    const { goal: _goal, ...source } = record;
    const fork: ChatSessionRecord = {
      ...source,
      ...turn.checkpoints.after,
      id: this.createId(),
      title: `${record.title.slice(0, 70)} · Branch`,
      titleOrigin: 'human',
      createdAt: timestamp,
      updatedAt: timestamp,
      transcript: record.transcript.slice(0, index + 1),
    };
    const conversation = createConversation(fork);
    await this.enqueue(() => this.saveWith(fork.id, fork));
    return this.remember(this.instantiate(fork.id, conversation));
  }

  rename(identifier: string, title: string): Promise<ChatSessionSummary> {
    this.requireInitialized();
    const normalized = title.replaceAll(/\s+/gu, ' ').trim();
    if (!normalized) return Promise.reject(new Error('Chat title cannot be empty.'));
    if (Array.from(normalized).length > 80)
      return Promise.reject(new Error('Chat title may contain at most 80 characters.'));
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
      const activePlan = this.activePlanBuild(chat.id);
      const items = update.items.map(item => {
        const id = activePlan?.builderTodoIdForLocal(item.id);
        return id ? { ...item, id } : item;
      });
      const byId = new Map((update.replace ? [] : (current.todos ?? [])).map(item => [item.id, item]));
      for (const item of items) byId.set(item.id, item);
      const todos = todoItemsSchema.parse([...byId.values()]);
      const updated = { ...current, todos, updatedAt: this.now().toISOString() };
      await this.saveWith(chat.id, updated);
      return toSummary(updated);
    });
  }

  createGoal(chat: ChatOwner, objective: string, signal?: AbortSignal): Promise<ChatSessionSummary> {
    this.requireInitialized();
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      const current = this.requireOwnedRecord(chat);
      if (current.goal && Goal.from(current.goal).isOpen)
        throw new GoalError('This chat already has a goal. Clear it before starting another.');
      const goal = Goal.create(this.createId(), objective, this.now()).toChatGoal();
      const untitled = current.titleOrigin === 'placeholder';
      const updated: ChatSessionRecord = {
        ...current,
        goal,
        ...(untitled
          ? { title: normalizeGeneratedTitle(await this.titles.generate(goal.objective)), titleOrigin: 'generated' }
          : {}),
        updatedAt: this.now().toISOString(),
      };
      await this.saveWith(chat.id, updated);
      return toSummary(updated);
    });
  }

  updateGoal(chat: ChatOwner, transform: (goal: Goal) => Goal, signal?: AbortSignal): Promise<ChatSessionSummary> {
    this.requireInitialized();
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      const current = this.requireOwnedRecord(chat);
      if (!current.goal) throw new GoalError('This chat has no goal.');
      const next = transform(Goal.from(current.goal)).toChatGoal();
      if (next === current.goal) return toSummary(current);
      const updated = { ...current, goal: chatGoalSchema.parse(next), updatedAt: this.now().toISOString() };
      await this.saveWith(chat.id, updated);
      return toSummary(updated);
    });
  }

  clearGoal(chat: ChatOwner): Promise<ChatSessionSummary> {
    this.requireInitialized();
    return this.enqueue(async () => {
      const { goal, ...current } = this.requireOwnedRecord(chat);
      if (!goal) return toSummary(current);
      const updated = { ...current, updatedAt: this.now().toISOString() };
      await this.saveWith(chat.id, updated);
      return toSummary(updated);
    });
  }

  setMode(id: string, mode: AgentModeID): Promise<ChatSessionSummary> {
    return this.enqueue(async () => {
      if (!AgentMode.isId(mode)) throw new PlanError('Unknown conversation mode.');
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
      if (update.id !== null && update.id !== '' && (!previous || previous.revision !== update.expectedRevision))
        throw new PlanError('The plan has changed. Read its current revision before editing.');
      if ((current.plans?.length ?? 0) >= 100)
        throw new PlanError('This chat has reached its saved plan revision limit.');
      const plan = previous ? GlyphPlan.from(previous).revise(update) : GlyphPlan.create(randomUUID(), chat.id, update);
      const updated = {
        ...current,
        plans: [...(current.plans ?? []), plan.toRecord()],
        updatedAt: this.now().toISOString(),
      };
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
      const updated = {
        ...current,
        plans: current.plans!.map(value =>
          value === plan ? GlyphPlan.from(plan).link(targetChatId, role).toRecord() : value,
        ),
      };
      await this.saveWith(chatId, updated);
      return toSummary(updated);
    });
  }

  startPlanBuild(
    chatId: string,
    planId: string,
    targetChatId: string,
    runId: string,
  ): Promise<readonly ChatSessionSummary[]> {
    return this.enqueue(async () => {
      const source = this.requireRecord(chatId);
      const target = this.requireRecord(targetChatId);
      if (source.accountId !== target.accountId || source.accountProvider !== target.accountProvider)
        throw new PlanError('Linked chats must use the same account.');
      const requestedPlan = source.plans?.findLast(value => value.id === planId);
      if (!requestedPlan) throw new PlanError('The plan is unavailable.');
      const paused = await this.updateBuilds(
        build => build.chatId === targetChatId,
        plan => plan.pauseBuild(),
      );
      const currentSource = this.requireRecord(chatId);
      const currentTarget = this.requireRecord(targetChatId);
      const currentPlan = GlyphPlan.from(currentSource.plans!.findLast(value => value.id === planId)!);
      const now = this.now();
      const updatedAt = now.toISOString();
      const buildingPlan = currentPlan.startBuild(targetChatId, runId, now);
      const building = withPlan(currentSource, currentPlan.toRecord(), buildingPlan.toRecord());
      const todos = todoItemsSchema.parse(buildingPlan.builderTodos());
      if (chatId === targetChatId) {
        const updated = { ...building, todos, updatedAt };
        await this.saveWith(chatId, updated);
        return this.changedSummaries([chatId], paused);
      }
      const builder = { ...currentTarget, todos, updatedAt };
      await this.saveWith(chatId, building);
      await this.saveWith(targetChatId, builder);
      return this.changedSummaries([chatId, targetChatId], paused);
    });
  }

  syncPlanBuild(chatId: string): Promise<readonly ChatSessionSummary[]> {
    return this.enqueue(async () => {
      const status = new Map((this.requireRecord(chatId).todos ?? []).map(todo => [todo.id, todo.status]));
      return this.updateBuilds(
        build => build.chatId === chatId,
        plan => plan.syncBuilderTodos(status),
      );
    });
  }

  finishPlanBuildRun(chatId: string, runId: string): Promise<readonly ChatSessionSummary[]> {
    return this.enqueue(() =>
      this.updateBuilds(
        build => build.chatId === chatId && build.runId === runId,
        plan => plan.finishBuildRun(chatId, runId),
      ),
    );
  }

  setPlanTodo(
    chatId: string,
    planId: string,
    todoId: string,
    completed: boolean,
  ): Promise<readonly ChatSessionSummary[]> {
    return this.enqueue(async () => {
      const source = this.requireRecord(chatId);
      const planRecord = source.plans?.findLast(value => value.id === planId);
      if (!planRecord) throw new PlanError('The plan is unavailable.');
      const plan = GlyphPlan.from(planRecord);
      const nextPlan = plan.setTodo(todoId, completed);
      const updatedAt = this.now().toISOString();
      const updated = { ...withPlan(source, planRecord, nextPlan.toRecord()), updatedAt };
      const builderId = plan.build?.chatId;
      const builder = builderId === chatId ? updated : builderId ? this.records.get(builderId) : undefined;
      const builderTodoId = plan.builderTodoIdForLocal(todoId)!;
      const tray = builder?.todos?.map(todo =>
        todo.id !== builderTodoId
          ? todo
          : {
              ...todo,
              status: completed
                ? TodoStatus.COMPLETED
                : todo.status === TodoStatus.COMPLETED
                  ? TodoStatus.PENDING
                  : todo.status,
            },
      );
      if (builder === updated && tray) {
        const both = { ...updated, todos: tray };
        await this.saveWith(chatId, both);
        return [toSummary(both)];
      }
      await this.saveWith(chatId, updated);
      if (!builder || !tray) return [toSummary(updated)];
      const tracked = { ...builder, todos: tray, updatedAt };
      await this.saveWith(builder.id, tracked);
      return [toSummary(updated), toSummary(tracked)];
    });
  }

  stopPlanBuild(chatId: string, planId: string): Promise<ChatSessionSummary> {
    return this.enqueue(async () => {
      const current = this.requireRecord(chatId);
      const plan = current.plans?.findLast(value => value.id === planId);
      if (!plan) throw new PlanError('The plan is unavailable.');
      const updated = {
        ...withPlan(current, plan, GlyphPlan.from(plan).pauseBuild().toRecord()),
        updatedAt: this.now().toISOString(),
      };
      await this.saveWith(chatId, updated);
      return toSummary(updated);
    });
  }

  async dispose(): Promise<void> {
    this.liveSessions.clear();
    await this.store.dispose();
  }

  private async updateBuilds(
    matches: (build: NonNullable<GlyphPlanRecord['build']>) => boolean,
    update: (plan: GlyphPlan) => GlyphPlan,
  ): Promise<readonly ChatSessionSummary[]> {
    const changed: ChatSessionSummary[] = [];
    for (const record of this.records.values()) {
      let next = record;
      for (const planRecord of new Map((record.plans ?? []).map(value => [value.id, value])).values()) {
        if (!planRecord.build || !matches(planRecord.build)) continue;
        const plan = GlyphPlan.from(planRecord);
        const updated = update(plan);
        if (updated !== plan) next = withPlan(next, planRecord, updated.toRecord());
      }
      if (next === record) continue;
      next = { ...next, updatedAt: this.now().toISOString() };
      await this.saveWith(record.id, next);
      changed.push(toSummary(next));
    }
    return changed;
  }

  private activePlanBuild(chatId: string): GlyphPlan | undefined {
    for (const record of this.records.values()) {
      const plan = [...new Map((record.plans ?? []).map(value => [value.id, value])).values()].find(
        value => value.build?.chatId === chatId,
      );
      if (plan) return GlyphPlan.from(plan);
    }
    return undefined;
  }

  private changedSummaries(
    primaryIds: readonly string[],
    changed: readonly ChatSessionSummary[],
  ): readonly ChatSessionSummary[] {
    const ids = new Set([...primaryIds, ...changed.map(chat => chat.id)]);
    return [...ids].map(id => toSummary(this.requireRecord(id)));
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
      (snapshot, transcript) =>
        this.enqueue(() =>
          this.saveWith(id, {
            ...this.requireRecord(id),
            ...snapshot,
            transcript,
            updatedAt: this.now().toISOString(),
          }),
        ),
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
    const records = new Map([...this.records, [id, record]]);
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

  private requireOwnedRecord(chat: ChatOwner): ChatSessionRecord {
    const record = this.requireRecord(chat.id);
    if (record.accountProvider !== chat.accountProvider || record.accountId !== chat.accountId)
      throw new GoalError('Goals must belong to the requesting chat account.');
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

function withPlan(record: ChatSessionRecord, previous: GlyphPlanRecord, plan: GlyphPlanRecord): ChatSessionRecord {
  return { ...record, plans: record.plans!.map(value => (value === previous ? plan : value)) };
}

function normalizeGeneratedTitle(title: string): string {
  const normalized = title.replaceAll(/\s+/gu, ' ').trim();
  const words = normalized.split(' ').filter(Boolean).slice(0, 4);
  const characters = Array.from(words.join(' '));
  return characters.slice(0, 80).join('') || 'New chat';
}
