export interface OpenAIAuthorizationAttempt {
  state: string;
  nonce: string;
  verifier: string;
  url: string;
  redirectUri: string;
  clientId: string | undefined;
}
