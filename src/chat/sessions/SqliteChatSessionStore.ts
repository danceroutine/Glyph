import { chmod, mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { PersistenceError } from '../../errors/PersistenceError.ts';
import type { ProjectContext } from '../../project/context/ProjectContext.ts';
import { ProjectContextIdentity } from '../../project/context/ProjectContextIdentity.ts';
import { ProjectContextKind } from '../../project/context/ProjectContextKind.ts';
import type { ChatSessionRecord } from './ChatSessionRecord.ts';
import type { ChatSessionStore } from './ChatSessionStore.ts';

const providerStateSchema = z
  .object({
    provider: z.string().min(1),
    version: z.number().int().positive(),
    data: z.json(),
  })
  .strict();

const transcriptTurnSchema = z
  .object({
    userText: z.string(),
    attachmentPaths: z.array(z.string().min(1)),
    assistantText: z.string(),
    reasoningSummary: z.string(),
    createdAt: z.iso.datetime(),
  })
  .strict();

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
    schemaVersion: z.literal(2),
    id: z.string().min(1),
    title: z.string().min(1),
    titleOrigin: z.enum(['placeholder', 'generated', 'human']),
    projectContextId: z.string().min(1),
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

interface ChatRow {
  readonly schema_version: number;
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
}

interface TurnRow {
  readonly user_text: string;
  readonly attachment_paths: string;
  readonly assistant_text: string;
  readonly reasoning_summary: string;
  readonly created_at: string;
}

/** SQLite-backed project-context catalog with atomic per-chat checkpoints. */
export class SqliteChatSessionStore implements ChatSessionStore {
  private readonly path: string;
  private readonly legacyPath: string;
  private database: Database.Database | undefined;

  constructor(private readonly directory: string) {
    this.path = join(directory, 'chats.sqlite3');
    this.legacyPath = join(directory, 'chats.json');
  }

  async initialize(context: ProjectContext): Promise<void> {
    if (!this.database) {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
        this.database = new Database(this.path);
        await chmod(this.path, 0o600);
        this.configure(this.database);
        this.createSchema(this.database);
        await this.migrateLegacyCatalog(this.database, context.authority);
      } catch (error) {
        this.database?.close();
        this.database = undefined;
        throw new PersistenceError('Could not initialize saved chats.', { cause: error });
      }
    }
    try {
      registerContext(this.requireDatabase(), context);
    } catch (error) {
      throw new PersistenceError('Could not register the active project context.', { cause: error });
    }
  }

  async load(projectContextId: string): Promise<readonly ChatSessionRecord[]> {
    try {
      const database = this.requireDatabase();
      const chats = database
        .prepare('SELECT * FROM chats WHERE project_context_id = ? ORDER BY updated_at DESC')
        .all(projectContextId) as ChatRow[];
      const turns = database.prepare(
        'SELECT user_text, attachment_paths, assistant_text, reasoning_summary, created_at FROM chat_turns WHERE chat_id = ? ORDER BY position',
      );
      return chats.map(row => toRecord(row, turns.all(row.id) as TurnRow[]));
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
    this.database?.close();
    this.database = undefined;
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
  }

  private async migrateLegacyCatalog(database: Database.Database, authority: string): Promise<void> {
    const migrated = database.prepare("SELECT value FROM metadata WHERE key = 'legacy_chats_json_migrated'").get() as
      { value: string } | undefined;
    if (migrated) return;
    let catalog: z.infer<typeof legacyCatalogSchema> | undefined;
    try {
      catalog = legacyCatalogSchema.parse(JSON.parse(await readFile(this.legacyPath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    database.transaction(() => {
      for (const legacy of catalog?.chats ?? []) {
        const context = legacyContext(legacy.scope.root, authority);
        registerContext(database, context);
        saveRecord(database, {
          schemaVersion: 2,
          id: legacy.id,
          title: legacy.title,
          titleOrigin: legacy.titleOrigin,
          projectContextId: context.id,
          accountClientId: legacy.accountClientId,
          accountSubject: legacy.accountSubject,
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
    })();
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
    context.roots.forEach((root, position) => insertRoot.run(context.id, position, root.name, root.path));
  })();
}

function saveRecord(database: Database.Database, record: ChatSessionRecord): void {
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO chats(
           id, schema_version, project_context_id, title, title_origin,
           account_client_id, account_subject, model_slug, model_name,
           created_at, updated_at, provider_state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           provider_state = excluded.provider_state`,
      )
      .run(
        record.id,
        record.schemaVersion,
        record.projectContextId,
        record.title,
        record.titleOrigin,
        record.accountClientId,
        record.accountSubject,
        record.modelSlug,
        record.modelName,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record.providerState),
      );
    database.prepare('DELETE FROM chat_turns WHERE chat_id = ?').run(record.id);
    const insertTurn = database.prepare(
      `INSERT INTO chat_turns(
         chat_id, position, user_text, attachment_paths, assistant_text, reasoning_summary, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    record.transcript.forEach((turn, position) =>
      insertTurn.run(
        record.id,
        position,
        turn.userText,
        JSON.stringify(turn.attachmentPaths),
        turn.assistantText,
        turn.reasoningSummary,
        turn.createdAt,
      ),
    );
  })();
}

function toRecord(row: ChatRow, turns: readonly TurnRow[]): ChatSessionRecord {
  return storedRecordSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    title: row.title,
    titleOrigin: row.title_origin,
    projectContextId: row.project_context_id,
    accountClientId: row.account_client_id,
    accountSubject: row.account_subject,
    modelSlug: row.model_slug,
    modelName: row.model_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    providerState: JSON.parse(row.provider_state),
    transcript: turns.map(turn => ({
      userText: turn.user_text,
      attachmentPaths: JSON.parse(turn.attachment_paths) as unknown,
      assistantText: turn.assistant_text,
      reasoningSummary: turn.reasoning_summary,
      createdAt: turn.created_at,
    })),
  });
}

function legacyContext(root: string, authority: string): ProjectContext {
  const path = resolve(root);
  const roots = [{ name: basename(path), path }];
  return {
    id: ProjectContextIdentity.create(ProjectContextKind.FOLDER, authority, path),
    kind: ProjectContextKind.FOLDER,
    name: basename(path),
    authority,
    roots,
  };
}
