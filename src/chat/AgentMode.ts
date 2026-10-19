/** Execution permissions for an agent turn. Serialized values remain stable. */
export enum AgentModeID {
  AGENT = 'agent',
  PLAN = 'plan',
}

interface AgentModeOptions {
  readonly name: string;
  readonly instructions: string;
  /** Receives a logical or canonical resource path; undefined means editing is allowed. */
  readonly editDenial: ((path: string) => string | undefined) | undefined;
}

/** Immutable domain behavior. Only its ID crosses persistence and process boundaries. */
export class AgentMode {
  readonly name: string;
  readonly instructions: string;
  private readonly editDenial: AgentModeOptions['editDenial'];

  private static readonly catalog: Readonly<Record<AgentModeID, AgentMode>> = Object.freeze({
    [AgentModeID.AGENT]: new AgentMode(AgentModeID.AGENT, {
      name: 'Agent',
      instructions: '',
      editDenial: undefined,
    }),
    [AgentModeID.PLAN]: new AgentMode(AgentModeID.PLAN, {
      name: 'Plan',
      instructions:
        'Plan Mode: use read-only tools, ask questions, and save plans. You may propose reviewed edits only to .md or .markdown files. Never execute shell commands or edit other files. To change mode, call interaction.request_mode_switch alone with the target mode and your reason; wait for approval.',
      editDenial: path =>
        /\.(md|markdown)$/i.test(path) ? undefined : 'Plan Mode can only edit Markdown files (.md or .markdown).',
    }),
  });

  static readonly all: readonly AgentMode[] = Object.freeze(Object.values(AgentMode.catalog));

  static readonly default = AgentMode.catalog[AgentModeID.AGENT];
  private constructor(
    readonly id: AgentModeID,
    options: AgentModeOptions,
  ) {
    this.name = options.name;
    this.instructions = options.instructions;
    this.editDenial = options.editDenial;
    Object.freeze(this);
  }

  static isId(value: unknown): value is AgentModeID {
    return typeof value === 'string' && Object.hasOwn(AgentMode.catalog, value);
  }

  static resolve(id: AgentModeID): AgentMode {
    if (!AgentMode.isId(id)) throw new Error(`Unknown conversation mode: ${String(id)}`);
    return AgentMode.catalog[id];
  }

  get title(): string {
    return `${this.name} Mode`;
  }

  get restrictsEdits(): boolean {
    return this.editDenial !== undefined;
  }

  getEditDenial(path: string): string | undefined {
    return this.editDenial?.(path);
  }
}
