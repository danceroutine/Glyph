import assert from 'node:assert/strict';
import { get } from 'node:http';
import { generateKeyPair, SignJWT } from 'jose';
import { OpenAIAuthenticationClient } from '#src/providers/openai/auth/OpenAIAuthenticationClient.js';

const issuer = 'https://issuer.example.test';
const { privateKey, publicKey } = await generateKeyPair('RS256');
let nonce = '';
const client = new OpenAIAuthenticationClient(
  { issuer, resource: 'https://api.example.test', scopes: 'openid', planScope: 'plan', requestTimeoutMs: 1000 },
  {
    get: async () => {
      throw new Error('Unexpected external request.');
    },
    post: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        access_token: 'fixture-access',
        refresh_token: 'fixture-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid',
        id_token: await new SignJWT({ nonce, email: 'fixture@example.test' })
          .setProtectedHeader({ alg: 'RS256' })
          .setIssuer(issuer)
          .setAudience('fixture-client')
          .setSubject('fixture-subject')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey),
      },
    }),
  },
  async () => publicKey,
);

function request(port: string, path: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port, path }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    }).once('error', reject);
  });
}

const result = await client.signIn('fixture-host', undefined, false, AbortSignal.timeout(5000), async ({ url }) => {
  const authorization = new URL(url);
  const redirect = new URL(authorization.searchParams.get('redirect_uri')!);
  nonce = authorization.searchParams.get('nonce')!;
  assert.equal(await request(redirect.port, '//['), 400);
  redirect.search = new URLSearchParams({
    state: authorization.searchParams.get('state')!,
    code: 'fixture-code',
    client_id: 'fixture-client',
  }).toString();
  assert.equal(await request(redirect.port, `${redirect.pathname}${redirect.search}`), 200);
});
assert.equal(result.subject, 'fixture-subject');
assert.equal(result.clientId, 'fixture-client');
