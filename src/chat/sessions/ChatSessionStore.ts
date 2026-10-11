import type { ChatSessionRecord } from './ChatSessionRecord.ts';
import type { ProjectContext } from '#src/project/context/ProjectContext.js';

/** Persistence port for project contexts and independently checkpointed chats. */
export interface ChatSessionStore {
  initialize(context: ProjectContext): Promise<void>;
  load(projectContextId: string): Promise<readonly ChatSessionRecord[]>;
  save(record: ChatSessionRecord): Promise<void>;
  dispose(): Promise<void>;
}
