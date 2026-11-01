import { AgentModeID } from '#src/chat/AgentMode.js';
import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { planSchema } from '#src/planning/PlanSchema.js';
import { chatTurnOptionsSchema } from '#src/chat/ChatTurnOptionsSchema.js';
import { shellCommandSummarySchema } from '#src/shell/ShellCommandSummary.js';
import { todoItemsSchema } from '#src/todos/TodoUpdate.js';
import { chatGoalSchema } from '#src/goals/GoalSchema.js';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import { PersistenceError } from '#src/errors/PersistenceError.js';
import type { ProjectContext } from '#src/project/context/ProjectContext.js';
import { ProjectContextIdentity } from '#src/project/context/ProjectContextIdentity.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import type { ChatSessionRecord } from './ChatSessionRecord.ts';
import type { ChatSessionStore } from './ChatSessionStore.ts';
import { errorCodeOf } from '#src/shared/mappers/errorCodeOf.js';
import {
  AgentInstructionActivationMode,
  AgentInstructionActivationReason,
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
} from '#src/instructions/AgentInstructionSource.js';

const providerStateSchema = z
  .object({
    provider: z.string().min(1),
    version: z.number().int().positive(),
    data: z.json(),
  })
  .strict();

const storedProviderStateSchema = z.object({ provider: z.string(), version: z.number(), data: z.unknown() }).loose();

const historyCheckpointSchema = z
  .object({
    providerState: providerStateSchema,
    plans: z.array(planSchema),
    todos: todoItemsSchema,
    mode: z.enum(AgentModeID),
  })
  .strict();

const instructionSourceSchema = z
  .object({
    id: z.string(),
    kind: z.enum(AgentInstructionSourceKind),
    label: z.string(),
    path: z.string(),
    scope: z.string(),
    status: z.enum(AgentInstructionSourceStatus),
    content: z.string().optional(),
    revision: z.string().optional(),
    sourceRevision: z.string().optional(),
    message: z.string().optional(),
    activation: z.enum(AgentInstructionActivationMode).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    globs: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    references: z.array(z.string()).optional(),
    uri: z.string().optional(),
  })
  .strict()
  .transform(
    ({
      content,
      revision,
      sourceRevision,
      message,
      activation,
      name,
      description,
      globs,
      enabled,
      references,
      uri,
      ...source
    }) => ({
      ...source,
      ...(content === undefined ? {} : { content }),
      ...(revision === undefined ? {} : { revision }),
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
      ...(message === undefined ? {} : { message }),
      ...(activation === undefined ? {} : { activation }),
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(globs === undefined ? {} : { globs }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(references === undefined ? {} : { references }),
      ...(uri === undefined ? {} : { uri }),
    }),
  );

const instructionTurnContextSchema = z
  .object({
    schema: z.literal('glyph.turn-context.v1'),
    turnId: z.string(),
    sources: z.array(instructionSourceSchema),
    activations: z.array(
      z
        .object({
          sourceId: z.string(),
          reason: z.enum(AgentInstructionActivationReason),
          paths: z.array(z.string()).optional(),
        })
        .strict()
        .transform(({ paths, ...activation }) => ({
          ...activation,
          ...(paths === undefined ? {} : { paths }),
        })),
    ),
    candidates: z.array(
      z.object({ id: z.string(), name: z.string(), description: z.string(), scope: z.string() }).strict(),
    ),
  })
  .strict();

const transcriptTurnSchema = z
  .object({
    steering: z
      .array(
        z
          .object({
            id: z.string(),
            text: z.string(),
            createdAt: z.iso.datetime(),
            options: chatTurnOptionsSchema,
            attachments: z.array(
              z
                .object({
                  path: z.string(),
                  text: z.string(),
                  revision: z.string(),
                  uri: z.string().optional(),
                  side: z.enum(['original', 'modified']).optional(),
                  range: z
                    .object({
                      start: z.object({ line: z.number(), column: z.number() }),
                      end: z.object({ line: z.number(), column: z.number() }),
                    })
                    .optional(),
                })
                .transform(({ uri, side, range, ...attachment }) => ({
                  ...attachment,
                  ...(uri !== undefined && uri !== '' ? { uri } : {}),
                  ...(side ? { side } : {}),
                  ...(range ? { range } : {}),
                })),
            ),
          })
          .strict(),
      )
      .optional(),
    checkpoints: z.object({ before: historyCheckpointSchema, after: historyCheckpointSchema }).strict().optional(),
    modeSwaps: z
      .array(
        z
          .object({
            id: z.string(),
            source: z.enum(AgentModeID),
            target: z.enum(AgentModeID),
            description: z.string(),
            status: z.enum(GlyphModeSwapStatus),
            startedAt: z.iso.datetime().optional(),
            expiresAt: z.iso.datetime(),
            autoApprove: z.boolean(),
          })
          .strict()
          .transform(({ startedAt, ...swap }) => ({
            ...swap,
            ...(startedAt !== undefined && startedAt !== '' ? { startedAt } : {}),
          })),
      )
      .optional(),
    questionResponses: z
      .array(
        z
          .object({ id: z.string(), answers: z.array(z.object({ question: z.string(), answer: z.string() }).strict()) })
          .strict(),
      )
      .optional(),
    options: chatTurnOptionsSchema.optional(),
    userText: z.string(),
    attachmentPaths: z.array(z.string().min(1)),
    attachments: z
      .array(
        z.object({
          path: z.string(),
          revision: z.string(),
          text: z.string(),
          byteOrderMark: z.boolean(),
          byteLength: z.number(),
          source: z
            .object({
              kind: z.enum(['selection', 'file', 'folder', 'diagnostic', 'symbol', 'diff', 'terminal', 'test']),
              uri: z.string(),
              version: z.number(),
              revision: z.string(),
              range: z
                .object({
                  start: z.object({ line: z.number(), column: z.number() }),
                  end: z.object({ line: z.number(), column: z.number() }),
                })
                .optional(),
              side: z.enum(['original', 'modified']).optional(),
            })
            .optional(),
        }),
      )
      .optional(),
    assistantText: z.string(),
    reasoningSummary: z.string(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        reasoningTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        incomplete: z.boolean().optional(),
      })
      .strict()
      .transform(({ incomplete, ...usage }) => ({ ...usage, ...(incomplete === undefined ? {} : { incomplete }) }))
      .optional(),
    context: instructionTurnContextSchema.optional(),
    tools: z
      .array(
        z
          .object({
            callId: z.string(),
            name: z.string(),
            phase: z.enum(ToolActivityPhase),
            shell: shellCommandSummarySchema.optional(),
            arguments: z.string().optional(),
            output: z.string().optional(),
            textOffset: z.number().int().nonnegative().optional(),
          })
          .strict()
          .transform(({ shell, arguments: args, output, textOffset, ...tool }) => ({
            ...tool,
            ...(shell === undefined ? {} : { shell }),
            ...(args === undefined ? {} : { arguments: args }),
            ...(output === undefined ? {} : { output }),
            ...(textOffset === undefined ? {} : { textOffset }),
          })),
      )
      .optional(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .transform(
    ({
      usage,
      context,
      tools,
      attachments,
      options,
      checkpoints,
      questionResponses,
      modeSwaps,
      steering,
      ...turn
    }) => ({
      ...(checkpoints ? { checkpoints } : {}),
      ...(questionResponses ? { questionResponses } : {}),
      ...(modeSwaps ? { modeSwaps } : {}),
      ...(steering ? { steering } : {}),
      ...(options ? { options } : {}),
      ...turn,
      ...(usage === undefined ? {} : { usage }),
      ...(context === undefined ? {} : { context }),
      ...(tools === undefined ? {} : { tools }),
      ...(attachments === undefined
        ? {}
        : {
            attachments: attachments.map(({ source, ...attachment }) => ({
              ...attachment,
              ...(source === undefined
                ? {}
                : {
                    source: {
                      kind: source.kind,
                      uri: source.uri,
                      version: source.version,
                      revision: source.revision,
                      ...(source.range ? { range: source.range } : {}),
                      ...(source.side ? { side: source.side } : {}),
                    },
                  }),
            })),
          }),
    }),
  );

const legacyRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    title: z.string().min(1),
    titleOrigin: z.enum(['placeholder', 'generated', 'human']),
    scope: z
      .object({
        kind: z.enum(['repository', 'workspace']),
        root: z.string().min(1),
      })
      .strict(),
    accountClientId: z.string().min(1),
    accountSubject: z.string().min(1),
    modelSlug: z.string().min(1),
    modelName: z.string().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    providerState: providerStateSchema,
    transcript: z.array(transcriptTurnSchema),
  })
  .strict();

const legacyCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    chats: z.array(legacyRecordSchema),
  })
  .strict();

const storedRecordSchema = z
  .object({
    schemaVersion: z.literal(3),
    mode: z.enum(AgentModeID).optional(),
    id: z.string().min(1),
    title: z.string().min(1),
    titleOrigin: z.enum(['placeholder', 'generated', 'human']),
    projectContextId: z.string().min(1),
    accountProvider: z.string().min(1),
    accountId: z.string().min(1),
    modelSlug: z.string().min(1),
    modelName: z.string().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    providerState: providerStateSchema,
    transcript: z.array(transcriptTurnSchema),
    plans: z.array(planSchema).max(100).optional(),
    todos: todoItemsSchema.optional(),
    goal: chatGoalSchema.optional(),
  })
  .strict()
  .transform(({ todos, plans, mode, goal, ...record }) => ({
    ...(mode !== undefined ? { mode } : {}),
    ...record,
    ...(plans ? { plans } : {}),
    ...(todos === undefined ? {} : { todos }),
    ...(goal === undefined ? {} : { goal }),
  }));

interface ChatRow {
  readonly schema_version: number;
  readonly mode: string | null;
  readonly id: string;
  readonly title: string;
  readonly title_origin: string;
  readonly project_context_id: string;
  readonly account_client_id: string;
  readonly account_subject: string;
  readonly model_slug: string;
  readonly model_name: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly provider_state: string;
  readonly plans: string | null;
  readonly todos: string | null;
  readonly goal: string | null;
}

interface TurnRow {
  readonly question_responses: string | null;
  readonly steering: string | null;
  readonly mode_swaps: string | null;
  readonly checkpoints: string | null;
  readonly options: string | null;
  readonly user_text: string;
  readonly attachment_paths: string;
  readonly attachments: string | null;
  readonly assistant_text: string;
  readonly reasoning_summary: string;
  readonly created_at: string;
  readonly usage: string | null;
  readonly context: string | null;
  readonly tools: string | null;
}

/** SQLite-backed project-context catalog with atomic per-chat checkpoints. */
export class SqliteChatSessionStore implements ChatSessionStore {
  private readonly path: string;
  private readonly legacyPath: string;
  private database: Database.Database | undefined;
  private initialization: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly directory: string,
    private readonly options: {
      readonly contextMigration?: { readonly targetId: string; readonly sourceIds: readonly string[] };
    } = {},
  ) {
    this.path = join(directory, 'chats.sqlite3');
    this.legacyPath = join(directory, 'chats.json');
  }

  async initialize(context: ProjectContext): Promise<void> {
    if (this.disposed)
      throw new PersistenceError('Could not initialize saved chats.', {
        cause: new Error('Chat storage has stopped.'),
      });
    // A connection is not ready until its schema and legacy import are ready.
    // Share that whole operation when multiple contexts use this store at once.
    await (this.initialization ??= this.openDatabase(context.authority).catch(error => {
      this.initialization = undefined;
      throw error;
    }));
    try {
      if (this.disposed) throw new Error('Chat storage has stopped.');
      const database = this.requireDatabase();
      const migration = this.options.contextMigration;
      if (migration && migration.targetId !== context.id)
        throw new Error('Chat migration target does not match the active context.');
      database.transaction(() => {
        registerContext(database, context);
        // Only the host supplies previous identities for this same container.
        // Move ownership atomically; chat ids, transcripts and provider state
        // remain untouched, and an already migrated catalog is a no-op.
        const migrate = database.prepare('UPDATE chats SET project_context_id = ? WHERE project_context_id = ?');
        for (const sourceId of migration?.sourceIds ?? []) {
          if (sourceId !== context.id) migrate.run(context.id, sourceId);
        }
      })();
    } catch (error) {
      throw new PersistenceError('Could not register the active project context.', { cause: error });
    }
  }

  async load(projectContextId: string): Promise<readonly ChatSessionRecord[]> {
    try {
      const database = this.requireDatabase();
      const chats = database
        .prepare<[string], ChatRow>('SELECT * FROM chats WHERE project_context_id = ? ORDER BY updated_at DESC')
        .all(projectContextId);
      const turns = database.prepare<[string], TurnRow>(
        'SELECT steering, mode_swaps, question_responses, checkpoints, options, user_text, attachment_paths, attachments, assistant_text, reasoning_summary, created_at, usage, context, tools FROM chat_turns WHERE chat_id = ? ORDER BY position',
      );
      return chats.map(row => toRecord(row, turns.all(row.id)));
    } catch (error) {
      throw new PersistenceError('Could not load saved chats.', { cause: error });
    }
  }

  async save(record: ChatSessionRecord): Promise<void> {
    try {
      saveRecord(this.requireDatabase(), storedRecordSchema.parse(record));
    } catch (error) {
      throw new PersistenceError('Could not persist saved chat.', { cause: error });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // A late startup must not publish an open handle after disposal returned.
    await this.initialization?.catch(() => {});
    this.database?.close();
    this.database = undefined;
    this.initialization = undefined;
  }

  private async openDatabase(authority: string): Promise<void> {
    let database: Database.Database | undefined;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      database = new Database(this.path);
      await chmod(this.path, 0o600);
      this.configure(database);
      this.createSchema(database);
      await this.migrateLegacyCatalog(database, authority);
      if (this.disposed) throw new Error('Chat storage has stopped.');
      this.database = database;
    } catch (error) {
      database?.close();
      throw new PersistenceError('Could not initialize saved chats.', { cause: error });
    }
  }

  private configure(database: Database.Database): void {
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('busy_timeout = 5000');
  }

  private createSchema(database: Database.Database): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_contexts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('folder', 'workspace')),
        name TEXT NOT NULL,
        authority TEXT NOT NULL,
        workspace_file TEXT
      );
      CREATE TABLE IF NOT EXISTS project_roots (
        project_context_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (project_context_id, position),
        UNIQUE (project_context_id, name)
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        project_context_id TEXT NOT NULL REFERENCES project_contexts(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        title_origin TEXT NOT NULL CHECK (title_origin IN ('placeholder', 'generated', 'human')),
        account_client_id TEXT NOT NULL,
        account_subject TEXT NOT NULL,
        model_slug TEXT NOT NULL,
        model_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        provider_state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chats_context_updated ON chats(project_context_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS chat_turns (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        user_text TEXT NOT NULL,
        attachment_paths TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        reasoning_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, position)
      );
    `);
    // Take the write reservation before inspecting columns: another workspace
    // may open this shared catalog at the same time during an upgrade.
    database
      .transaction(() => {
        const chatColumns = database.prepare<[], { name: string }>('PRAGMA table_info(chats)').all();
        if (!chatColumns.some(value => value.name === 'todos'))
          database.exec('ALTER TABLE chats ADD COLUMN todos TEXT');
        if (!chatColumns.some(value => value.name === 'mode')) database.exec('ALTER TABLE chats ADD COLUMN mode TEXT');
        if (!chatColumns.some(value => value.name === 'plans'))
          database.exec('ALTER TABLE chats ADD COLUMN plans TEXT');
        if (!chatColumns.some(value => value.name === 'goal')) database.exec('ALTER TABLE chats ADD COLUMN goal TEXT');
        const columns = database.prepare<[], { name: string }>('PRAGMA table_info(chat_turns)').all();
        for (const column of [
          'usage',
          'tools',
          'attachments',
          'options',
          'checkpoints',
          'question_responses',
          'mode_swaps',
          'steering',
          'context',
        ]) {
          if (!columns.some(value => value.name === column))
            database.exec(`ALTER TABLE chat_turns ADD COLUMN ${column} TEXT`);
        }
      })
      .immediate();
  }

  private async migrateLegacyCatalog(database: Database.Database, authority: string): Promise<void> {
    const migrated = database
      .prepare<[], { value: string }>("SELECT value FROM metadata WHERE key = 'legacy_chats_json_migrated'")
      .get();
    if (migrated) return;
    let catalog: z.infer<typeof legacyCatalogSchema> | undefined;
    try {
      catalog = legacyCatalogSchema.parse(JSON.parse(await readFile(this.legacyPath, 'utf8')));
    } catch (error) {
      if (errorCodeOf(error) !== 'ENOENT') throw error;
    }
    database
      .transaction(() => {
        // The legacy read yielded to other workspaces. Check again while holding
        // the write reservation, before importing anything or publishing a marker.
        // Otherwise a second importer could overwrite a newer chat checkpoint.
        if (
          database
            .prepare<[], { value: string }>("SELECT value FROM metadata WHERE key = 'legacy_chats_json_migrated'")
            .get() !== undefined
        )
          return;
        for (const legacy of catalog?.chats ?? []) {
          const context = legacyContext(legacy.scope.root, authority);
          registerContext(database, context);
          saveRecord(database, {
            schemaVersion: 3,
            id: legacy.id,
            title: legacy.title,
            titleOrigin: legacy.titleOrigin,
            projectContextId: context.id,
            accountProvider: 'openai',
            accountId: legacyAccountId(legacy.accountClientId, legacy.accountSubject),
            modelSlug: legacy.modelSlug,
            modelName: legacy.modelName,
            createdAt: legacy.createdAt,
            updatedAt: legacy.updatedAt,
            providerState: legacy.providerState,
            transcript: legacy.transcript,
          });
        }
        database
          .prepare("INSERT INTO metadata(key, value) VALUES ('legacy_chats_json_migrated', ?)")
          .run(new Date().toISOString());
      })
      .immediate();
  }

  private requireDatabase(): Database.Database {
    if (!this.database) throw new Error('Chat storage has not been initialized.');
    return this.database;
  }
}

function registerContext(database: Database.Database, context: ProjectContext): void {
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO project_contexts(id, kind, name, authority, workspace_file)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           authority = excluded.authority,
           workspace_file = excluded.workspace_file`,
      )
      .run(context.id, context.kind, context.name, context.authority, context.workspaceFile ?? null);
    database.prepare('DELETE FROM project_roots WHERE project_context_id = ?').run(context.id);
    const insertRoot = database.prepare(
      'INSERT INTO project_roots(project_context_id, position, name, path) VALUES (?, ?, ?, ?)',
    );
    context.roots.forEach((root, position) => {
      insertRoot.run(context.id, position, root.name, root.path);
    });
  })();
}

function saveRecord(database: Database.Database, record: ChatSessionRecord): void {
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO chats(
           id, schema_version, project_context_id, title, title_origin,
           account_client_id, account_subject, model_slug, model_name,
           created_at, updated_at, provider_state, todos, plans, mode, goal
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           schema_version = excluded.schema_version,
           project_context_id = excluded.project_context_id,
           title = excluded.title,
           title_origin = excluded.title_origin,
           account_client_id = excluded.account_client_id,
           account_subject = excluded.account_subject,
           model_slug = excluded.model_slug,
           model_name = excluded.model_name,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           provider_state = excluded.provider_state,
           todos = excluded.todos,
           plans = excluded.plans,
           mode = excluded.mode,
           goal = excluded.goal`,
      )
      .run(
        record.id,
        record.schemaVersion,
        record.projectContextId,
        record.title,
        record.titleOrigin,
        record.accountProvider,
        record.accountId,
        record.modelSlug,
        record.modelName,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record.providerState),
        record.todos ? JSON.stringify(record.todos) : null,
        record.plans ? JSON.stringify(record.plans) : null,
        record.mode ?? null,
        record.goal ? JSON.stringify(record.goal) : null,
      );
    database.prepare('DELETE FROM chat_turns WHERE chat_id = ?').run(record.id);
    const insertTurn = database.prepare(
      `INSERT INTO chat_turns(
         chat_id, position, user_text, attachment_paths, assistant_text, reasoning_summary, created_at, usage, context, tools, attachments, options, checkpoints, question_responses, mode_swaps, steering
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    record.transcript.forEach((turn, position) => {
      insertTurn.run(
        record.id,
        position,
        turn.userText,
        JSON.stringify(turn.attachmentPaths),
        turn.assistantText,
        turn.reasoningSummary,
        turn.createdAt,
        turn.usage ? JSON.stringify(turn.usage) : null,
        turn.context ? JSON.stringify(turn.context) : null,
        turn.tools ? JSON.stringify(turn.tools) : null,
        turn.attachments ? JSON.stringify(turn.attachments) : null,
        turn.options ? JSON.stringify(turn.options) : null,
        turn.checkpoints ? JSON.stringify(turn.checkpoints) : null,
        turn.questionResponses ? JSON.stringify(turn.questionResponses) : null,
        turn.modeSwaps ? JSON.stringify(turn.modeSwaps) : null,
        turn.steering ? JSON.stringify(turn.steering) : null,
      );
    });
  })();
}

function toRecord(row: ChatRow, turns: readonly TurnRow[]): ChatSessionRecord {
  return storedRecordSchema.parse({
    schemaVersion: 3,
    ...(row.mode !== null && row.mode !== '' ? { mode: row.mode } : {}),
    id: row.id,
    title: row.title,
    titleOrigin: row.title_origin,
    projectContextId: row.project_context_id,
    accountProvider: row.schema_version >= 3 ? row.account_client_id : 'openai',
    accountId:
      row.schema_version >= 3 ? row.account_subject : legacyAccountId(row.account_client_id, row.account_subject),
    modelSlug: row.model_slug,
    modelName: row.model_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    providerState: storedProviderStateSchema.parse(JSON.parse(row.provider_state)),
    ...(row.plans == null ? {} : { plans: JSON.parse(row.plans) as unknown }),
    ...(row.todos === null ? {} : { todos: JSON.parse(row.todos) as unknown }),
    ...(row.goal == null ? {} : { goal: JSON.parse(row.goal) as unknown }),
    transcript: turns.map(turn => ({
      ...(turn.steering == null ? {} : { steering: JSON.parse(turn.steering) as unknown }),
      ...(turn.mode_swaps == null ? {} : { modeSwaps: JSON.parse(turn.mode_swaps) as unknown }),
      ...(turn.question_responses == null ? {} : { questionResponses: JSON.parse(turn.question_responses) as unknown }),
      ...(turn.checkpoints == null ? {} : { checkpoints: JSON.parse(turn.checkpoints) as unknown }),
      ...(turn.options == null ? {} : { options: JSON.parse(turn.options) as unknown }),
      userText: turn.user_text,
      attachmentPaths: JSON.parse(turn.attachment_paths) as unknown,
      ...(turn.attachments === null ? {} : { attachments: JSON.parse(turn.attachments) as unknown }),
      assistantText: turn.assistant_text,
      reasoningSummary: turn.reasoning_summary,
      createdAt: turn.created_at,
      ...(turn.usage === null ? {} : { usage: JSON.parse(turn.usage) as unknown }),
      ...(turn.context === null ? {} : { context: JSON.parse(turn.context) as unknown }),
      ...(turn.tools === null ? {} : { tools: JSON.parse(turn.tools) as unknown }),
    })),
  });
}

function legacyAccountId(clientId: string, subject: string): string {
  return JSON.stringify([clientId, subject]);
}

function legacyContext(root: string, authority: string): ProjectContext {
  const path = resolve(root);
  const roots = [{ name: basename(path), path }];
  return {
    id: ProjectContextIdentity.create(ProjectContextKind.FOLDER, authority, path),
    mutationIdentity: ProjectContextIdentity.createMutationScope(ProjectContextKind.FOLDER, authority, roots),
    kind: ProjectContextKind.FOLDER,
    name: basename(path),
    authority,
    roots,
  };
}
