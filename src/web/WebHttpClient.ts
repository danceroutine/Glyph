import { WebRequestError } from './WebRequestError.ts';
import { webUrl } from './WebUrl.ts';

/** Anonymous, bounded requests; never forwards account tokens, cookies, or page scripts. */
export class WebHttpClient {
  constructor(
    private readonly transport: typeof fetch = fetch,
    private readonly limits = { maxBytes: 1024 * 1024, timeoutMs: 20_000, maxRedirects: 5 },
  ) {}

  async read(value: string, cancellation: AbortSignal): Promise<{ url: string; contentType: string; text: string }> {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(this.limits.timeoutMs)]);
    let url = webUrl(value);
    try {
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        const response = await this.transport(url, {
          signal,
          redirect: 'manual',
          credentials: 'omit',
          headers: {
            Accept: 'text/html, text/plain, text/markdown, application/json;q=0.8',
            'User-Agent': 'Glyph/0.2 WebTools',
          },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirects >= this.limits.maxRedirects)
            throw new WebRequestError('REDIRECT_LIMIT', 'The page has an invalid redirect or too many redirects.');
          url = webUrl(new URL(location, url).href);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new WebRequestError('HTTP_ERROR', `The website returned HTTP ${response.status}.`);
        }
        const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (
          !['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json'].includes(
            contentType,
          )
        ) {
          await response.body?.cancel();
          throw new WebRequestError(
            'UNSUPPORTED_CONTENT',
            `Unsupported page content type: ${contentType || 'unspecified'}.`,
          );
        }
        if (Number(response.headers.get('content-length')) > this.limits.maxBytes) {
          await response.body?.cancel();
          throw new WebRequestError('RESPONSE_TOO_LARGE', 'The page exceeds the 1 MiB download limit.');
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          if (reader)
            for (;;) {
              signal.throwIfAborted();
              const { done, value } = await reader.read();
              if (done) break;
              length += value.byteLength;
              if (length > this.limits.maxBytes)
                throw new WebRequestError('RESPONSE_TOO_LARGE', 'The page exceeds the download limit.');
              chunks.push(value);
            }
        } finally {
          await reader?.cancel().catch(() => {});
          reader?.releaseLock();
        }
        signal.throwIfAborted();
        const bytes = Buffer.concat(chunks);
        const charset =
          /charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
        let decoder: TextDecoder;
        try {
          decoder = new TextDecoder(charset);
        } catch {
          decoder = new TextDecoder();
        }
        return { url: url.href, contentType, text: decoder.decode(bytes) };
      }
    } catch (error) {
      cancellation.throwIfAborted();
      if (signal.aborted) throw new WebRequestError('TIMEOUT', 'The website did not respond before the timeout.');
      if (error instanceof WebRequestError) throw error;
      throw new WebRequestError('NETWORK_ERROR', 'The website could not be reached.');
    }
  }
}
