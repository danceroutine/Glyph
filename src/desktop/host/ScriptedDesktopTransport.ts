/**
 * Explicit Electron-test transport. Only the model catalog, Responses, and web fixture
 * requests reach the local fixture; unexpected requests never fall back to the network.
 * Application services, tools, account storage, and chat persistence remain real.
 */
export class ScriptedDesktopTransport {
  private readonly endpoint: URL;

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const search = url.origin === 'https://html.duckduckgo.com' && url.pathname === '/html/';
    const page = url.origin === this.endpoint.origin && url.pathname.startsWith('/web/');
    if (request.method === 'GET' && (search || page)) {
      return fetch(new URL((search ? '/web/search' : url.pathname) + url.search, this.endpoint), {
        method: 'GET',
        signal: request.signal,
        redirect: 'manual',
        headers: { Accept: request.headers.get('accept') ?? 'text/html' },
      });
    }
    if (
      url.origin !== 'https://api.openai.com' ||
      !(
        (request.method === 'GET' && url.pathname === '/v1/models') ||
        (request.method === 'POST' && url.pathname === '/v1/responses')
      )
    ) {
      throw new Error('Unexpected request in the scripted desktop provider. Live network fallback is disabled.');
    }
    return fetch(new URL(url.pathname + url.search, this.endpoint), {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      redirect: 'error',
      ...(request.method === 'POST' ? { body: await request.text() } : {}),
    });
  };

  constructor(endpoint: string) {
    this.endpoint = new URL(endpoint);
    if (
      this.endpoint.protocol !== 'http:' ||
      this.endpoint.hostname !== '127.0.0.1' ||
      !this.endpoint.port ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.pathname !== '/' ||
      this.endpoint.search ||
      this.endpoint.hash
    ) {
      throw new Error('The scripted desktop provider requires an explicit http://127.0.0.1:port endpoint.');
    }
  }
}
