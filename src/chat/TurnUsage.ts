import type { Usage } from './Usage.ts';

/** Counts reported across a turn's provider requests, with explicit gaps in reporting. */
export interface TurnUsage extends Usage {
  readonly incomplete?: boolean;
}
