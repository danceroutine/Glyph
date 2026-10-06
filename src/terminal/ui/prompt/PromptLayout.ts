export const PROMPT_RAIL_HORIZONTAL_PADDING = 1;
export const PROMPT_RAIL_TOP_MARGIN = 1;
export const PROMPT_RAIL_BORDER_HEIGHT = 1;

export function promptRailCursorY(railTop: number, pendingChanges: number): number {
  return railTop + PROMPT_RAIL_BORDER_HEIGHT + (pendingChanges > 0 ? 1 : 0);
}
