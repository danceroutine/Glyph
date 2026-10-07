/** Durable chat ownership captured when a model stages a proposal. */
export interface EditProposalOrigin {
  readonly chatId: string;
  readonly accountProvider: string;
  readonly accountId: string;
}
