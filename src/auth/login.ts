import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { makeAttempt, validateCallback, exchange, verifyIdentity, requiredString, RESOURCE } from './protocol.ts';
import type { Account } from './store.ts';

export async function login(hostId: string, existing?: Account, consent = false): Promise<{ clientId: string; subject: string; email: string; response: Record<string, unknown> }> {
  let resolveCallback!: (value: { code: string; clientId: string }) => void;
  let rejectCallback!: (reason: Error) => void;
  const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  // Attach a handler immediately, including while the browser launcher is starting.
  void callback.catch(() => {});
  let attempt: ReturnType<typeof makeAttempt> | undefined;
  let consumed = false;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== '/auth/callback' || !attempt || consumed) { response.writeHead(404).end('Not found.'); return; }
    try {
      const value = validateCallback(url, attempt);
      consumed = true;
      response.end('Authorization received. Return to the terminal to finish verification.');
      resolveCallback(value);
    } catch (error) {
      response.writeHead(400).end('Authorization rejected. Return to the terminal.');
      // Unrelated local requests cannot terminate the pending login.
      if (url.searchParams.get('state') === attempt.state) {
        consumed = true;
        rejectCallback(error instanceof Error ? error : new Error('OAuth callback rejected.'));
      }
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Could not bind the local callback.'); }
  attempt = makeAttempt(hostId, `http://127.0.0.1:${address.port}/auth/callback`, existing?.clientId, consent);
  const timer = setTimeout(() => rejectCallback(new Error('Sign-in timed out after five minutes.')), 300_000);
  const cancel = () => rejectCallback(new Error('Sign-in cancelled.'));
  process.once('SIGINT', cancel);
  try {
    console.log('\nContinue with ChatGPT\nAuthorize Harness Chat to use your ChatGPT plan.\n');
    // No ID/access/refresh token is included in this URL.
    console.log(`If the browser does not open, visit:\n${attempt.url}\n`);
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    if (process.platform !== 'win32') {
      const child = spawn(command, [attempt.url], { stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    }
    const { code, clientId } = await callback;
    const response = await exchange({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE });
    const identity = await verifyIdentity(requiredString(response.id_token, 'id_token'), clientId, attempt.nonce, existing?.subject);
    return { clientId, ...identity, response };
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', cancel);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
