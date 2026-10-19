/** Human-readable answers retained in the conversation after a form is submitted. */
export interface GlyphQuestionResponse {
  readonly id: string;
  readonly answers: readonly { readonly question: string; readonly answer: string }[];
}
