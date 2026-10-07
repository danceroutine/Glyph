import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { ToolActivity as ToolActivityModel } from '#src/chat/ToolActivity.ts';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.ts';
import { sanitizeText } from '../shared/sanitizeText.ts';

export interface ToolActivityProps {
  activity: ToolActivityModel;
  frame?: number;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const TOOL_TAG_BACKGROUND = '#c4a7e7';
const TOOL_TAG_FOREGROUND = '#211d2e';
const TOOL_STATUS_RUNNING_BACKGROUND = '#f6c177';
const TOOL_STATUS_SUCCESS_BACKGROUND = '#9ece6a';
const TOOL_STATUS_ERROR_BACKGROUND = '#eb6f92';

export function ToolActivity({ activity, frame = 0 }: ToolActivityProps): ReactElement {
  const name = activity.namespace ? `${activity.namespace}.${activity.name}` : activity.name;
  if (activity.phase === ToolActivityPhase.STARTED) {
    const icon = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
    return <ToolTag name={name} icon={icon} statusBackground={TOOL_STATUS_RUNNING_BACKGROUND} />;
  }
  const result = formatToolResult(activity);
  if (!result.failed) {
    return <ToolTag name={name} icon="✓" statusBackground={TOOL_STATUS_SUCCESS_BACKGROUND} />;
  }
  const argumentsText = sanitizeText(activity.arguments).trimEnd();
  return (
    <Box flexDirection="column">
      <ToolTag name={name} icon="×" statusBackground={TOOL_STATUS_ERROR_BACKGROUND} statusForeground="whiteBright" />
      {argumentsText ? <Text dimColor>{indent(argumentsText)}</Text> : null}
      <Text color="red">{`  ${result.message}`}</Text>
    </Box>
  );
}

interface ToolTagProps {
  name: string;
  icon: string;
  statusBackground: string;
  statusForeground?: string;
}

function ToolTag({ name, icon, statusBackground, statusForeground = TOOL_TAG_FOREGROUND }: ToolTagProps): ReactElement {
  return (
    <Box>
      <Box backgroundColor={TOOL_TAG_BACKGROUND} paddingX={1}>
        <Text bold color={TOOL_TAG_FOREGROUND}>
          {name}
        </Text>
      </Box>
      <Box backgroundColor={statusBackground} paddingX={1}>
        <Text bold color={statusForeground}>
          {icon}
        </Text>
      </Box>
    </Box>
  );
}

function indent(value: string): string {
  return value
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
}

function formatToolResult(activity: ToolActivityModel): { message: string; failed: boolean } {
  try {
    const result: unknown = JSON.parse(activity.output ?? '');
    if (typeof result === 'object' && result !== null && 'error' in result) {
      return { message: `Error: ${formatToolError((result as { error: unknown }).error)}`, failed: true };
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
