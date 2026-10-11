import type { ToolInputKind } from '#src/tools/ToolInputKind.js';

export interface ScriptedToolInvocation {
  readonly namespace: string;
  readonly name: string;
  readonly callId: string;
  readonly inputKind: ToolInputKind;
  readonly input: unknown;
}
