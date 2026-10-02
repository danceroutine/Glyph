import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected server response shape.');
  return value as Record<string, unknown>;
}
export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Server response missing ${field}.`);
  return value;
}
export function makeAttempt(hostId: string, redirectUri: string, clientId?: string, consent = false) {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId,
    response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE,
    state, nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ...(!clientId ? { agent_name_hint: 'Harness Chat' } : {}),
    ...(consent ? { prompt: 'consent' } : {}),
  }).toString();
  return { state, nonce, verifier, url: url.toString(), redirectUri, clientId };
}
export type Attempt = ReturnType<typeof makeAttempt>;
export function validateCallback(url: URL, attempt: Attempt): { code: string; clientId: string } {
  for (const key of ['state', 'code', 'client_id', 'error']) {
    if (url.searchParams.getAll(key).length > 1) throw new Error('Duplicate OAuth callback parameter.');
  }
  const state = url.searchParams.get('state') ?? '';
  if (Buffer.byteLength(state) !== Buffer.byteLength(attempt.state) || !timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state))) throw new Error('OAuth state mismatch.');
  if (url.searchParams.has('error')) throw new Error('Sign-in was declined or could not be completed.');
  const returnedId = url.searchParams.get('client_id');
  if (attempt.clientId && returnedId && attempt.clientId !== returnedId) throw new Error('OAuth client ID changed during reauthorization.');
  const clientId = returnedId ?? attempt.clientId;
  if (!clientId || clientId === 'dynamic_agent_client') throw new Error('Registration did not return an issued client ID.');
  return { clientId, code: requiredString(url.searchParams.get('code'), 'authorization code') };
}
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
export async function verifyIdentity(idToken: string, clientId: string, nonce?: string, subject?: string, key: JWTVerifyGetKey = jwks) {
  const { payload } = await jwtVerify(idToken, key, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
  if (nonce !== undefined && payload.nonce !== nonce) throw new Error('ID token nonce mismatch.');
  if (subject !== undefined && payload.sub !== subject) throw new Error('The signed-in identity does not match this saved account.');
  return { subject: requiredString(payload.sub, 'subject'), email: typeof payload.email === 'string' ? payload.email : '(email unavailable)' };
}
export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, status: number) { super(`OAuth ${status}: ${code}.`); this.code = code; }
}
export async function exchange(form: Record<string, string>, transport: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const response = await transport(TOKEN_URL, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(30_000) });
  const body = record(await response.json());
  if (!response.ok) throw new OAuthError(typeof body.error === 'string' ? body.error : 'token_exchange_failed', response.status);
  return body;
}
