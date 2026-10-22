export interface GlyphPlanBuildOrder {
  readonly planId: string;
  readonly revision: number;
  readonly title: string;
  readonly sourceChatId: string;
  readonly todos: readonly { readonly id: string; readonly text: string; readonly completed: boolean }[];
}
