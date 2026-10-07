export const PromptLayout = {
  railHorizontalPadding: 1,
  railTopMargin: 1,
  railBorderHeight: 1,
  railCursorY(railTop: number, pendingChanges: number, acceptsSubmission: boolean): number {
    return railTop + this.railBorderHeight + (pendingChanges > 0 ? 1 : 0) + (acceptsSubmission ? 0 : 1);
  },
} as const;
