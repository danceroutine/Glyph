import type { GlyphPlan } from '#src/desktop/protocol/events/GlyphPlan.js';
export interface GlyphPlanViewState {
  readonly plan: GlyphPlan;
  readonly modelLabel?: string;
  readonly disabled: boolean;
  readonly agents: readonly { readonly chatId: string; readonly title: string; readonly role: string }[];
}
export interface GlyphPlanViewActions {
  update(plan: GlyphPlan): Promise<void>;
  build(newChat?: boolean): Promise<void>;
  newAgent(): Promise<void>;
  openChat(id: string): Promise<void>;
  readonly copyText?: (text: string) => Promise<void>;
  openLink(href: string): Promise<void>;
}
export type GlyphPlanMount = (
  container: HTMLElement,
  state: GlyphPlanViewState,
  actions: GlyphPlanViewActions,
) => { update(state: GlyphPlanViewState): void; dispose(): void };
