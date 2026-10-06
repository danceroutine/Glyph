import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { ToolActivity } from '../../chat/ToolActivity.ts';
import { ToolActivityPhase } from '../../chat/ToolActivityPhase.ts';
import { sanitizeText } from '../TerminalEditReviewer.ts';

export interface ToolActivityPresentationalProps {
  activity: ToolActivity;
}

export function ToolActivityPresentational({ activity }: ToolActivityPresentationalProps): ReactElement {
  const name = activity.namespace ? `${activity.namespace}.${activity.name}` : activity.name;
  if (activity.phase === ToolActivityPhase.STARTED) {
    const argumentsText = sanitizeText(activity.arguments).trimEnd();
    return (
      <Box flexDirection="column">
        <Text color="yellow">{`[tool> ${name}]`}</Text>
        {argumentsText ? <Text dimColor>{indent(argumentsText)}</Text> : null}
      </Box>
    );
  }
  const result = formatToolResult(activity);
  return (
    <Text bold={result.failed} color={result.failed ? 'red' : 'green'}>
      {`[tool< ${name} ${result.message}]`}
    </Text>
  );
}

function indent(value: string): string {
  return value
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
}

function formatToolResult(activity: ToolActivity): { message: string; failed: boolean } {
  try {
    const result: unknown = JSON.parse(activity.output ?? '');
    if (typeof result === 'object' && result !== null && 'error' in result) {
      return { message: `error: ${formatToolError((result as { error: unknown }).error)}`, failed: true };
    }
  } catch {
    // Non-JSON output is still a successful tool result.
  }
  return { message: 'completed', failed: false };
}

function formatToolError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return formatToolErrorValue(error);
  const details = error as Record<string, unknown>;
  const code = typeof details.code === 'string' ? details.code : undefined;
  const message = typeof details.message === 'string' ? details.message : undefined;
  const context = Object.entries(details)
    .filter(([key]) => key !== 'code' && key !== 'message')
    .map(([key, value]) => `${key}=${formatToolErrorValue(value)}`);
  const description = [code, message].filter(Boolean).join(': ') || formatToolErrorValue(error);
  return context.length > 0 ? `${description} (${context.join('; ')})` : description;
}

function formatToolErrorValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(formatToolErrorValue).join(', ');
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return 'Unprintable error details';
  }
}
