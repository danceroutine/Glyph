export const GOAL_COMMAND_USAGE = 'Usage: /goal <objective>';

export function parseGoalCommand(text: string): string | undefined {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  return match ? (match[1] ?? '').trim() : undefined;
}
