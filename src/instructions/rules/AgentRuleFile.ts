import type { AgentInstructionActivationMode } from '#src/instructions/AgentInstructionSource.js';

/** Parsed frontmatter and body of one native or compatible rule file. */
export interface AgentRuleFile {
  /** Display name; defaults to the source filename without `.mdc`. */
  readonly name?: string;
  /** Bounded relevance description used for model-selected rules. */
  readonly description?: string;
  /** Explicit native activation mode. Compatibility files infer this from Cursor metadata. */
  readonly activation?: AgentInstructionActivationMode;
  /** File patterns relative to the rule's project scope. */
  readonly globs: readonly string[];
  /** Cursor-compatible always-on flag. */
  readonly alwaysApply?: boolean;
  /** Persistent enablement stored in native user and project rule files. */
  readonly enabled: boolean;
  /** Authorized files whose contents are appended to the rule body. */
  readonly references: readonly string[];
  /** Markdown instruction body after frontmatter. */
  readonly body: string;
}
