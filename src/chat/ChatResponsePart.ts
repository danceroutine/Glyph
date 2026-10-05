import { ChatResponsePartType } from './ChatResponsePartType.ts';
import { DiagnosticSeverity } from './DiagnosticSeverity.ts';
import type { ToolActivity } from './ToolActivity.ts';

export type ChatResponsePart =
  | { type: ChatResponsePartType.TEXT; value: string }
  | { type: ChatResponsePartType.REASONING_SUMMARY; value: string }
  | { type: ChatResponsePartType.TOOL; activity: ToolActivity }
  | { type: ChatResponsePartType.DIAGNOSTIC; severity: DiagnosticSeverity; message: string };
