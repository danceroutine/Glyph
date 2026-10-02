import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { makeAttempt, validateCallback, verifyIdentity, ISSUER, PLAN_SCOPE, exchange, RESOURCE } from '../src/auth/protocol.ts';
import { CredentialStore } from '../src/auth/store.ts';
import type { Account } from '../src/auth/store.ts';
import { Session, parseTokens } from '../src/auth/session.ts';
import { listModels } from '../src/models.ts';

const tokenBody = { access_token: 'access-secret', refresh_token: 'refresh-secret', id_token: 'id-secret', token_type: 'Bearer', expires_in: 3600, scope: `openid ${PLAN_SCOPE}` };

test('dynamic registration uses PKCE, expected resource and plan scope', () => {
  const attempt = makeAttempt('urn:uuid:test', 'http://127.0.0.1:1234/auth/callback');
  const url = new URL(attempt.url);
  assert.equal(url.origin, ISSUER);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('resource'), RESOURCE);
  assert.ok(url.searchParams.get('scope')?.includes(PLAN_SCOPE));
  assert.ok(url.searchParams.get('agent_name_hint'));
  assert.notEqual(attempt.verifier, url.searchParams.get('code_challenge'));
  assert.notEqual(attempt.state, makeAttempt('urn:uuid:test', attempt.redirectUri).state);
});

test('callback rejects forged state, missing issued client, duplicate parameters and client changes', () => {
  const attempt = makeAttempt('urn:uuid:test', 'http://127.0.0.1:1234/auth/callback');
  const callback = new URL(attempt.redirectUri);
  callback.search = new URLSearchParams({ code: 'code', client_id: 'oaiapp_example', state: attempt.state }).toString();
  assert.deepEqual(validateCallback(callback, attempt), { code: 'code', clientId: 'oaiapp_example' });
  assert.throws(() => validateCallback(callback, { ...attempt, state: 'forged' }), /state mismatch/);
  assert.throws(() => validateCallback(callback, { ...attempt, clientId: 'different' }), /changed/);
  callback.searchParams.append('state', attempt.state);
  assert.throws(() => validateCallback(callback, attempt), /Duplicate/);
  callback.searchParams.delete('state'); callback.searchParams.set('state', attempt.state);
  callback.searchParams.delete('client_id');
  assert.throws(() => validateCallback(callback, attempt), /issued client ID/);
  callback.searchParams.set('error', 'access_denied');
  assert.throws(() => validateCallback(callback, attempt), /declined/);
});

test('returning sign-in reuses client and avoids token-bearing URLs', () => {
  const attempt = makeAttempt('urn:uuid:test', 'http://127.0.0.1:1234/auth/callback', 'oaiapp_saved');
  const url = new URL(attempt.url);
  assert.equal(url.searchParams.get('client_id'), 'oaiapp_saved');
  assert.equal(url.searchParams.has('agent_name_hint'), false);
  assert.equal(url.searchParams.has('id_token_hint'), false);
  assert.equal(url.searchParams.has('prompt'), false);
  const callback = new URL(attempt.redirectUri);
  callback.search = new URLSearchParams({ code: 'code', state: attempt.state }).toString();
  assert.equal(validateCallback(callback, attempt).clientId, 'oaiapp_saved');
});

test('ID token signature, issuer, audience, expiry, nonce, and subject are validated', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' }] });
  const mint = (issuer = ISSUER, expires = '5m') => new SignJWT({ nonce: 'nonce', email: 'test@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience('client').setSubject('subject').setIssuedAt().setExpirationTime(expires).sign(privateKey);
  const token = await mint();
  assert.equal((await verifyIdentity(token, 'client', 'nonce', 'subject', key)).subject, 'subject');
  await assert.rejects(verifyIdentity(token, 'wrong', 'nonce', undefined, key));
  await assert.rejects(verifyIdentity(token, 'client', 'wrong', undefined, key), /nonce/);
  await assert.rejects(verifyIdentity(token, 'client', 'nonce', 'other', key), /identity/);
  await assert.rejects(verifyIdentity(await mint('https://wrong.example'), 'client', 'nonce', undefined, key));
  await assert.rejects(verifyIdentity(await mint(ISSUER, '-1h'), 'client', 'nonce', undefined, key));
  const other = await generateKeyPair('RS256');
  const wrongKey = createLocalJWKSet({ keys: [{ ...await exportJWK(other.publicKey), kid: 'test', alg: 'RS256' }] });
  await assert.rejects(verifyIdentity(token, 'client', 'nonce', undefined, wrongKey));
});

test('code exchange uses issued client, exact callback and verifier without client secret', async () => {
  await exchange({ grant_type: 'authorization_code', client_id: 'issued', code: 'code', code_verifier: 'verifier', redirect_uri: 'http://127.0.0.1:4321/auth/callback', resource: RESOURCE }, async (url, init) => {
    assert.equal(String(url), `${ISSUER}/api/accounts/oauth/token`);
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get('client_id'), 'issued');
    assert.equal(form.get('redirect_uri'), 'http://127.0.0.1:4321/auth/callback');
    assert.equal(form.get('code_verifier'), 'verifier');
    assert.equal(form.has('client_secret'), false);
    return Response.json(tokenBody);
  });
});

test('credential store persists stable host, restricts permissions, and excludes concurrent instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-auth-'));
  const store = new CredentialStore(dir);
  try {
    await store.acquire(); await store.load();
    const other = new CredentialStore(dir);
    await assert.rejects(other.acquire(), /Another instance/);
    await other.load(); assert.equal(other.state.hostId, store.state.hostId);
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'accounts.json'))).mode & 0o777, 0o600);
    await store.release(); await other.acquire(); await other.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing plan consent blocks inference and secrets are redacted', async () => {
  const store = new CredentialStore('/unused');
  const account: Account = { clientId: 'issued', subject: 'subject', email: 'email', tokens: parseTokens({ ...tokenBody, scope: 'openid' }) };
  store.state.accounts.push(account);
  const session = new Session(store);
  await assert.rejects(session.accessToken(account), /not granted/);
  assert.equal(session.redact('access-secret refresh-secret id-secret'), '[REDACTED] [REDACTED] [REDACTED]');
});

test('refresh is serialized, rotates and persists credentials, and retains granted scopes when omitted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-refresh-'));
  const store = new CredentialStore(dir);
  const originalFetch = globalThis.fetch;
  try {
    await store.acquire(); await store.load();
    const account: Account = { clientId: 'issued', subject: 'subject', email: 'email', tokens: { ...parseTokens(tokenBody), expiresAt: 0 } };
    store.state.accounts.push(account);
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('client_id'), 'issued');
      assert.equal(form.get('refresh_token'), 'refresh-secret');
      assert.equal(form.has('scope'), false);
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 });
    };
    const session = new Session(store);
    assert.deepEqual(await Promise.all([session.accessToken(account), session.accessToken(account)]), ['new-access', 'new-access']);
    assert.equal(calls, 1);
    const saved = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8'));
    assert.equal(saved.accounts[0].tokens.refreshToken, 'new-refresh');
    assert.ok(saved.accounts[0].tokens.scopes.includes(PLAN_SCOPE));
  } finally { globalThis.fetch = originalFetch; await store.release(); await rm(dir, { recursive: true, force: true }); }
});

test('model catalog uses OAuth token and keeps visible model ordering', async () => {
  const result = await listModels('oauth-token', async (url, init) => {
    assert.equal(String(url), `${RESOURCE}/models`);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer oauth-token');
    return Response.json({ models: [ { slug: 'a', display_name: 'A', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }, { slug: 'b', display_name: 'B', visibility: 'list' } ] });
  });
  assert.deepEqual(result.map(m => m.slug), ['a', 'b']);
});

test('terminal refresh rejection clears tokens but retains account registration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-expired-'));
  const store = new CredentialStore(dir);
  const originalFetch = globalThis.fetch;
  try {
    await store.acquire(); await store.load();
    const account: Account = { clientId: 'issued', subject: 'subject', email: 'email', tokens: { ...parseTokens(tokenBody), expiresAt: 0 } };
    store.state.accounts.push(account);
    globalThis.fetch = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    await assert.rejects(new Session(store).accessToken(account), /expired or was revoked/);
    assert.equal(account.tokens, undefined);
    assert.equal(store.state.accounts[0]?.clientId, 'issued');
  } finally { globalThis.fetch = originalFetch; await store.release(); await rm(dir, { recursive: true, force: true }); }
});

test('logout revokes the renewable session and retains registration without tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-logout-'));
  const store = new CredentialStore(dir);
  const originalFetch = globalThis.fetch;
  try {
    await store.acquire(); await store.load();
    const account: Account = { clientId: 'issued', subject: 'subject', email: 'email', tokens: parseTokens(tokenBody) };
    store.state.accounts.push(account);
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('openid-configuration')) return Response.json({ revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke` });
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('token'), 'refresh-secret');
      assert.equal(form.get('client_id'), 'issued');
      return new Response('', { status: 200 });
    };
    assert.equal(await new Session(store).logout(account), true);
    assert.equal(account.tokens, undefined);
    assert.equal(store.state.accounts[0]?.subject, 'subject');
  } finally { globalThis.fetch = originalFetch; await store.release(); await rm(dir, { recursive: true, force: true }); }
});
