export interface GlyphPlanProgress {
  readonly planId: string;
  readonly title: string;
  readonly current?: string;
  readonly completed: number;
  readonly total: number;
}
