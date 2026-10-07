export interface ChatAccountNotice {
  readonly message: string;
  readonly acknowledgementPrompt: string;
  readonly url?: string;
}

/** Provider-neutral account identity and activation state exposed to hosts. */
export interface ChatAccount {
  readonly provider: string;
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly connected: boolean;
  readonly inferenceAccess: boolean;
  readonly accessPrompt?: string;
  readonly notice?: ChatAccountNotice;
}
