import type { ShellSessionSnapshot } from './ShellSessionSnapshot.ts';

/** Observable background-terminal state consumed by host presentation layers. */
export interface ShellSessionRegistry {
  readonly sessions: readonly ShellSessionSnapshot[];
  onDidChange(listener: () => void): () => void;
}
