import { WebRequestError } from './WebRequestError.ts';

export function webUrl(value: string): URL {
  const url = URL.parse(value);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new WebRequestError('INVALID_URL', 'Use an HTTP or HTTPS URL without embedded credentials.');
  if (url.href.length > 2048) throw new WebRequestError('INVALID_URL', 'The URL exceeds 2048 characters.');
  url.hash = '';
  return url;
}
