import type { ToolDefinition } from './ToolDefinition.ts';
import type { ToolRuntime } from './ToolRuntime.ts';

/** Combines independent tool domains while preserving provider-neutral dispatch. */
export class CompositeToolRuntime implements ToolRuntime {
  readonly definitions: readonly ToolDefinition[];
  private readonly runtimesByName = new Map<string, ToolRuntime>();

  constructor(runtimes: readonly ToolRuntime[]) {
    this.definitions = runtimes.flatMap(runtime => runtime.definitions);
    for (const runtime of runtimes) {
      for (const definition of runtime.definitions) {
        if (this.runtimesByName.has(definition.name)) {
          throw new Error(`Tool names must be globally unique: ${definition.name}`);
        }
        this.runtimesByName.set(definition.name, runtime);
      }
    }
  }

  async execute(name: string, input: string, signal?: AbortSignal): Promise<string> {
    const runtime = this.runtimesByName.get(name);
    if (!runtime) throw new Error(`Unknown tool: ${name}`);
    return runtime.execute(name, input, signal);
  }
}
