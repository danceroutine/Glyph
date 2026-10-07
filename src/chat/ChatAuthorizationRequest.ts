/** Browser authorization instructions supplied by an account backend. */
export interface ChatAuthorizationRequest {
  readonly url: string;
  readonly title: string;
  readonly message: string;
}

export type ChatAuthorizationHandler = (request: ChatAuthorizationRequest) => void | Promise<void>;
