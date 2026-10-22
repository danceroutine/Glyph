import { AgentMode, AgentModeID } from '#src/chat/AgentMode.js';
import { useDropdownState } from '#code-oss/ui/Dropdown/useDropdownState.ts';
export interface GlyphModePickerOptions {
  readonly mode: AgentModeID;
  readonly change: (mode: AgentModeID) => void;
}
export function useGlyphModePickerState({ mode, change }: GlyphModePickerOptions) {
  const modes = AgentMode.all;
  const selectedIndex = modes.findIndex(value => value.id === mode);
  const dropdown = useDropdownState({
    items: modes,
    selectedIndex,
    label: value => value.name,
    choose: value => {
      change(value.id);
    },
  });
  return { ...dropdown, mode, modes, selectedIndex };
}
export type GlyphModePickerState = ReturnType<typeof useGlyphModePickerState>;
