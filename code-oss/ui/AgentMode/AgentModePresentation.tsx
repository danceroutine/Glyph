import type { ComponentType } from 'preact';
import { List } from 'lucide-preact';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { GlyphAgentIcon } from '#code-oss/ui/GlyphModePicker/GlyphAgentIcon.presentational.tsx';
import { tokens } from '#code-oss/ui/design-system/index.ts';

export interface AgentModePresentation {
  readonly Icon: ComponentType;
  readonly accent: string;
  readonly badge: { readonly color: string; readonly background: string };
  readonly send: { readonly color: string; readonly background: string };
}

/** Every domain mode must explicitly provide its shared UI treatment. */
export const AGENT_MODE_PRESENTATION = Object.freeze({
  [AgentModeID.AGENT]: {
    Icon: GlyphAgentIcon,
    accent: tokens.text.muted,
    badge: { color: tokens.text.muted, background: tokens.button.secondary.background },
    send: { color: tokens.input.background, background: tokens.text.primary },
  },
  [AgentModeID.PLAN]: {
    Icon: () => <List size={16} aria-hidden="true" />,
    accent: tokens.text.warning,
    badge: { color: tokens.text.warning, background: `color-mix(in srgb, ${tokens.text.warning} 24%, transparent)` },
    send: { color: tokens.surface.canvas, background: tokens.text.warning },
  },
} satisfies Record<AgentModeID, AgentModePresentation>);
