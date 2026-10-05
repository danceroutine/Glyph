import type { AuthorizationRequest } from './AuthorizationRequest.ts';

export type AuthorizationHandler = (request: AuthorizationRequest) => void | Promise<void>;
