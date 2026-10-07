import { describe, expect, it } from 'vitest';
import { ExtractiveChatTitleGenerator } from '../ExtractiveChatTitleGenerator.ts';

describe(ExtractiveChatTitleGenerator, () => {
  it.each([
    ['Please fix the authentication race condition in login', 'Fix Authentication Race Condition'],
    ['Add JSON API pagination support today', 'Add JSON API Pagination'],
    ['can you help me', 'Can You Help Me'],
    ['', 'New chat'],
  ])('names %j as %j', async (message, expected) => {
    await expect(new ExtractiveChatTitleGenerator().generate(message)).resolves.toBe(expected);
  });
});
