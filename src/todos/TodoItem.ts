import type { TodoStatus } from './TodoStatus.ts';

/** A stable, agent-owned action item within one chat. */
export interface TodoItem {
  readonly id: string;
  readonly text: string;
  readonly status: TodoStatus;
}
