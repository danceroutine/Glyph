import { AgentModeID } from '#src/chat/AgentMode.js';
import type { Tool } from './Tool.ts';
import type { ToolSource } from './ToolSource.ts';

export interface ToolIdentity {
  readonly name: string;
  readonly namespace?: string;
}

/** Resolves qualified identities. A provider may omit the namespace only for an unambiguous name. */
export class ToolRegistry implements ToolSource {
  readonly tools: readonly Tool[];
  private readonly qualified = new Map<string, Tool>();
  private readonly byName = new Map<string, Tool[]>();

  constructor(tools: readonly Tool[]) {
    this.tools = Object.freeze(
      tools.map(tool => {
        if (!tool.namespace || !tool.name) throw new Error('Tools require a namespace and name.');
        if (
          !Array.isArray(tool.allowedModes) ||
          tool.allowedModes.length === 0 ||
          tool.allowedModes.some(mode => !Object.values(AgentModeID).includes(mode))
        ) {
          throw new Error(`Tool ${tool.namespace}.${tool.name} must explicitly declare valid allowed modes.`);
        }
        if (typeof tool.validateInput !== 'function' || typeof tool.execute !== 'function') {
          throw new Error(`Tool ${tool.namespace}.${tool.name} requires validation and execution.`);
        }
        // Snapshot policy and handlers so later mutation cannot change a registered permission.
        const registered: Tool = Object.freeze({
          ...tool,
          allowedModes: Object.freeze([...tool.allowedModes]) as Tool['allowedModes'],
          validateInput: tool.validateInput.bind(tool),
          execute: tool.execute.bind(tool),
        });
        const key = this.key(tool);
        if (this.qualified.has(key)) throw new Error(`Duplicate tool: ${tool.namespace}.${tool.name}`);
        this.qualified.set(key, registered);
        this.byName.set(tool.name, [...(this.byName.get(tool.name) ?? []), registered]);
        return registered;
      }),
    );
  }

  resolve(identity: ToolIdentity): Tool {
    if (identity.namespace !== undefined) {
      const tool = this.qualified.get(this.key(identity));
      if (!tool) throw new Error(`Unknown tool: ${identity.namespace}.${identity.name}`);
      return tool;
    }
    const candidates = this.byName.get(identity.name) ?? [];
    if (candidates.length > 1) throw new Error(`Ambiguous tool name: ${identity.name}. Supply its namespace.`);
    if (!candidates[0]) throw new Error(`Unknown tool: ${identity.name}`);
    return candidates[0];
  }

  private key(identity: ToolIdentity): string {
    return JSON.stringify([identity.namespace, identity.name]);
  }
}
