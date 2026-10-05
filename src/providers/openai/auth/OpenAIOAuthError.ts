import { AuthenticationError } from '../../../errors/AuthenticationError.ts';

export class OpenAIOAuthError extends AuthenticationError {
  constructor(readonly code: string, status: number) {
    super(`OAuth ${status}: ${code}.`);
  }
}
