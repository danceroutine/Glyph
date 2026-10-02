export interface Config { model: string; instructions: string; timeoutMs: number }
export function readConfig(model: string, env: NodeJS.ProcessEnv = process.env): Config {
  const timeoutMs = Number(env.CHAT_TIMEOUT_MS || 120000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('CHAT_TIMEOUT_MS must be a positive integer.');
  return { model, instructions: env.CHAT_INSTRUCTIONS ?? 'You are a helpful assistant. Be clear and concise.', timeoutMs };
}
