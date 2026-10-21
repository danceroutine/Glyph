import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { describeError } from '#src/describeError.js';

describe(describeError, () => {
  it('returns the message of an ordinary error', () => {
    expect(describeError(new Error('Disk is full.'))).toBe('Disk is full.');
  });

  it('describes a non-error value as unexpected', () => {
    expect(describeError('boom')).toBe('Unexpected error.');
  });

  it('describes an OpenAI failure with its status and request identifier', () => {
    const error = new OpenAI.APIError(
      500,
      { message: 'Server exploded' },
      undefined,
      new Headers({ 'x-request-id': 'req_123' }),
    );

    expect(describeError(error)).toBe('OpenAI HTTP 500: 500 Server exploded\nRequest ID: req_123');
  });

  it('describes an OpenAI failure without a status or request identifier', () => {
    const error = new OpenAI.APIError(undefined, undefined, 'Connection lost', undefined);

    expect(describeError(error)).toBe('OpenAI HTTP error: Connection lost');
  });

  it('suggests signing in again when OpenAI rejects the credentials', () => {
    const error = new OpenAI.APIError(401, { message: 'Unauthorized' }, undefined, new Headers());

    expect(describeError(error)).toBe(
      'OpenAI HTTP 401: 401 Unauthorized\nCheck the selected ChatGPT account and permissions. Use /login if the session was revoked.',
    );
  });

  it('explains eligibility limits when OpenAI forbids the operation', () => {
    const error = new OpenAI.APIError(403, { message: 'Forbidden' }, undefined, new Headers());

    expect(describeError(error)).toBe(
      'OpenAI HTTP 403: 403 Forbidden\nThe selected account, workspace, region, or operation may not be eligible for this preview.',
    );
  });

  it('finds an OpenAI failure nested in the cause chain', () => {
    const apiError = new OpenAI.APIError(429, { message: 'Slow down' }, undefined, new Headers());
    const error = new Error('Turn failed.', { cause: new Error('Provider failed.', { cause: apiError }) });

    expect(describeError(error)).toBe('OpenAI HTTP 429: 429 Slow down');
  });

  it('ignores a cause chain that ends in a non-error value', () => {
    const error = new Error('Turn failed.', { cause: 'socket closed' });

    expect(describeError(error)).toBe('Turn failed.');
  });

  it('points to usage settings when the plan limit is exceeded', () => {
    expect(describeError(new Error('code: subscription_sharing_usage_limit_exceeded'))).toBe(
      'code: subscription_sharing_usage_limit_exceeded\nPlan or app usage limit reached. Review https://chatgpt.com/settings/usage',
    );
  });

  it.each(['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'])(
    'asks to retry later when subscription usage reports %s',
    code => {
      expect(describeError(new Error(code))).toBe(
        `${code}\nSubscription usage is temporarily unavailable. Retry later.`,
      );
    },
  );
});
