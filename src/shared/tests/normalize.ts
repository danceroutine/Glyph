import { stripVTControlCharacters } from 'node:util';

export const normalize = (text: string): string =>
  stripVTControlCharacters(text)
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n');
