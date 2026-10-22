import { pathToFileURL } from 'node:url';

// The tiny upstream-owned bootstrap lets Code OSS launch a stable module path;
// the separately built Glyph artifact can then move independently of upstream.
const entry = process.env['GLYPH_DESKTOP_HOST_ENTRY'];
if (entry === undefined || entry === '') {
  throw new Error('GLYPH_DESKTOP_HOST_ENTRY is required.');
}

await import(pathToFileURL(entry).href);
