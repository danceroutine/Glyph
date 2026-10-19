import type { AgentModeID } from '#src/chat/AgentMode.js';
import type { ToolInputKind } from './ToolInputKind.ts';
import type { ToolExecutionContext } from './ToolExecutionContext.ts';

/**
 * A capability registered with ToolRegistry and invoked through ToolExecutor.
 * The executor checks mode permissions and round exclusivity, validates input,
 * then executes. Resource-specific restrictions and approvals remain the
 * responsibility of the tool and its domain services.
 */
export interface Tool {
  /**
   * Nonempty list of modes that may invoke this tool. Unlisted modes are denied,
   * including modes added later. Permission here does not waive resource policy,
   * such as Plan mode's restriction to Markdown edits.
   */
  readonly allowedModes: readonly [AgentModeID, ...AgentModeID[]];

  /**
   * When true, reject this invocation if the model returned other tool calls in
   * the same round. Used for transitions such as mode changes. Defaults to false;
   * this is not a lock across turns or chats.
   */
  readonly requiresExclusiveRound?: boolean;

  /** Nonempty routing scope; together with name, identifies one registered tool. */
  readonly namespace: string;

  /**
   * Nonempty name, unique within its namespace. A call may omit the namespace
   * only when this name is unambiguous across the registry.
   */
  readonly name: string;

  /** Model-facing guidance explaining when to call the tool and what it does. */
  readonly description: string;

  /**
   * Payload format advertised to providers: serialized JSON or free-form text.
   * Both formats reach validateInput and execute as the original input string.
   */
  readonly inputKind: ToolInputKind;

  /**
   * JSON Schema for a JSON tool's arguments, used by provider adapters to
   * describe the tool. Omit for text tools or JSON tools accepting an empty
   * object. This declaration does not replace runtime validation.
   */
  readonly parameters?: Record<string, unknown>;

  /**
   * Check the raw input and throw if it is invalid, without performing the
   * tool's side effects. The executor reports validation failures without
   * calling execute. No parsed value is retained: execute receives the same
   * input string and must parse it or delegate parsing to its domain service.
   */
  validateInput(input: string): void;

  /**
   * Perform the operation after executor checks and input validation succeed.
   * Enforce resource policy and obtain any required approval before mutation.
   * If cancellation arrives after an operation settles, preserve its outcome
   * in the returned result; the executor records it before stopping the turn.
   *
   * @param input Original payload, encoded according to inputKind.
   * @param signal Cooperative cancellation for this invocation.
   * @param context Host-supplied provenance and callbacks, independent of model input.
   * @returns Model-visible result, usually serialized JSON, including known domain failures.
   * @throws Unexpected failures; the executor conservatively reports an unknown outcome.
   */
  execute(input: string, signal: AbortSignal, context: ToolExecutionContext): Promise<string>;
}
