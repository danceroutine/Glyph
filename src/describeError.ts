import OpenAI from 'openai';
export function describeError(error: unknown): string {
  let message = error instanceof Error ? error.message : 'Unexpected error.';
  const apiError = findCause(error, candidate => candidate instanceof OpenAI.APIError);
  if (apiError instanceof OpenAI.APIError) {
    message = `OpenAI HTTP ${apiError.status ?? 'error'}: ${apiError.message}`;
    if (apiError.requestID) message += `\nRequest ID: ${apiError.requestID}`;
    if (apiError.status === 401)
      message += '\nCheck the selected ChatGPT account and permissions. Use /login if the session was revoked.';
    if (apiError.status === 403)
      message += '\nThe selected account, workspace, region, or operation may not be eligible for this preview.';
  }
  if (message.includes('subscription_sharing_usage_limit_exceeded'))
    message += '\nPlan or app usage limit reached. Review https://chatgpt.com/settings/usage';
  if (
    message.includes('subscription_sharing_usage_unavailable') ||
    message.includes('subscription_sharing_user_unavailable')
  )
    message += '\nSubscription usage is temporarily unavailable. Retry later.';
  return message;
}

function findCause(error: unknown, matches: (candidate: Error) => boolean): Error | undefined {
  let candidate = error;
  while (candidate instanceof Error) {
    if (matches(candidate)) return candidate;
    candidate = candidate.cause;
  }
  return undefined;
}
