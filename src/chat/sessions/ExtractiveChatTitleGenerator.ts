import type { ChatTitleGenerator } from './ChatTitleGenerator.ts';

const ignoredWords = new Set([
  'a',
  'an',
  'and',
  'can',
  'could',
  'for',
  'i',
  'in',
  'is',
  'it',
  'just',
  'let',
  'lets',
  'me',
  'of',
  'on',
  'please',
  'the',
  'this',
  'to',
  'up',
  'we',
  'with',
  'you',
]);

/** Fast local title generator used until a host supplies a model-backed implementation. */
export class ExtractiveChatTitleGenerator implements ChatTitleGenerator {
  async generate(firstMessage: string): Promise<string> {
    const words = firstMessage.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? [];
    const meaningful = words.filter(word => !ignoredWords.has(word.toLocaleLowerCase('en-US')));
    const selected = (meaningful.length >= 3 ? meaningful : words).slice(0, 4);
    if (selected.length === 0) return 'New chat';
    return selected.map(titleCase).join(' ');
  }
}

function titleCase(word: string): string {
  if (/^[A-Z0-9_-]{2,}$/u.test(word)) return word;
  return `${word.slice(0, 1).toLocaleUpperCase('en-US')}${word.slice(1)}`;
}
