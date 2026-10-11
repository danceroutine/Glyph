import { AuthenticationError } from '#src/errors/AuthenticationError.js';

export class OpenAIOAuthError extends AuthenticationError {
  constructor(
    readonly code: string,
    status: number,
  ) {
    super(`OAuth ${status}: ${code}.`);
  }
}
