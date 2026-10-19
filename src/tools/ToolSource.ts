import type { Tool } from './Tool.ts';

/** A domain service can supply several independently authorized tools. */
export interface ToolSource {
  readonly tools: readonly Tool[];
}
