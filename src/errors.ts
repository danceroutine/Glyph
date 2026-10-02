import OpenAI from 'openai';
export function describeError(error: unknown): string {
  let message = error instanceof Error ? error.message : 'Unexpected error.';
  if (error instanceof OpenAI.APIError) {
    message = `OpenAI HTTP ${error.status ?? 'error'}: ${error.message}`;
    if (error.requestID) message += `\nRequest ID: ${error.requestID}`;
    if (error.status === 401) message += '\nCheck the selected ChatGPT account and permissions. Use /login if the session was revoked.';
    if (error.status === 403) message += '\nThe selected account, workspace, region, or operation may not be eligible for this preview.';
  }
  if (message.includes('subscription_sharing_usage_limit_exceeded')) message += '\nPlan or app usage limit reached. Review https://chatgpt.com/settings/usage';
  if (message.includes('subscription_sharing_usage_unavailable') || message.includes('subscription_sharing_user_unavailable')) message += '\nSubscription usage is temporarily unavailable. Retry later.';
  return message;
}
