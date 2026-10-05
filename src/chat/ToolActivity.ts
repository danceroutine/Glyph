import type { ToolActivityPhase } from './ToolActivityPhase.ts';

export interface ToolActivity {
  phase: ToolActivityPhase;
  namespace?: string;
  name: string;
  callId: string;
  arguments: string;
  output?: string;
}
