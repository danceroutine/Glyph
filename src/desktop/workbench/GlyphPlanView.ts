import type { GlyphPlanRecord } from '#src/desktop/protocol/events/GlyphPlanRecord.js';
export interface GlyphPlanViewState {
  readonly plan: GlyphPlanRecord;
  readonly modelLabel?: string;
  readonly disabled: boolean;
  readonly building?: boolean;
  readonly agents: readonly { readonly chatId: string; readonly title: string; readonly role: string }[];
}
export interface GlyphPlanViewActions {
  update(plan: GlyphPlanRecord): Promise<void>;
  setTodo(todoId: string, completed: boolean): Promise<void>;
  build(newChat?: boolean): Promise<void>;
  stopBuild(): Promise<void>;
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
