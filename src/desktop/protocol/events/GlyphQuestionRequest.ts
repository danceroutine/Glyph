export interface GlyphQuestionRequest {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly questions?: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly allowMultiple: boolean;
    readonly options: readonly { readonly id: string; readonly label: string }[];
  }[];
  readonly expiresAt?: string;
}
