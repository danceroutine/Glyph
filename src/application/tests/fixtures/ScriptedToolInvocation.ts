import type { ToolInputKind } from '../../../tools/ToolInputKind.ts';

export interface ScriptedToolInvocation {
  readonly namespace: string;
  readonly name: string;
  readonly callId: string;
  readonly inputKind: ToolInputKind;
  readonly input: unknown;
}
