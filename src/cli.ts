#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stripVTControlCharacters } from 'node:util';
import { CredentialStore } from './auth/store.ts';
import type { Account } from './auth/store.ts';
import { Session } from './auth/session.ts';
import { PLAN_SCOPE } from './auth/protocol.ts';
import { readConfig } from './config.ts';
import { describeError } from './errors.ts';
import { listModels } from './models.ts';
import { OpenAIProvider } from './openai-provider.ts';
import type { Usage } from './provider.ts';

const clean = (text: string): string => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const help = `Commands: /help /reset /usage /account /login /logout /exit
Ctrl+C cancels a response; at a prompt it exits.
Subscription authentication only. API-key environment variables are ignored.`;
const formatUsage = (u: Usage): string => `input ${u.inputTokens} (cached ${u.cachedInputTokens}) | output ${u.outputTokens} (reasoning ${u.reasoningTokens}) | total ${u.totalTokens}`;

async function main(): Promise<void> {
  if (process.argv.includes('--help')) { console.log(`Harness Chat | Sign in with ChatGPT\n${help}`); return; }
  if (!process.stdin.isTTY) throw new Error('Run npm start in an interactive terminal for account and model selection.');
  const store = new CredentialStore();
  await store.acquire();
  const session = new Session(store);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let active: AbortController | undefined;
  let closed = false;
  input.on('close', () => { closed = true; active?.abort(); });
  input.on('SIGINT', () => { if (active) active.abort(); else { process.emit('SIGINT'); input.close(); } });
  const ask = async (text: string): Promise<string> => {
    if (closed) throw new Error('Session closed.');
    return input.question(text);
  };
  const total: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  async function chooseAccount(): Promise<Account> {
    for (;;) {
      console.log('\nChatGPT accounts:');
      store.state.accounts.forEach((a, i) => console.log(`${i + 1}. ${clean(a.email)} [${clean(a.clientId)}]${a.tokens ? '' : ' (signed out)'}`));
      console.log('n. Continue with ChatGPT (add account/workspace)');
      const choice = (await ask('Account number or n: ')).trim();
      if (choice === 'n') return session.signIn();
      const account = store.state.accounts[Number(choice) - 1];
      if (!account || !/^\d+$/.test(choice)) { console.log('Choose an account number or n.'); continue; }
      return account.tokens ? account : session.signIn(account);
    }
  }
  async function chooseModel(account: Account): Promise<OpenAIProvider> {
    if (!account.tokens?.scopes.includes(PLAN_SCOPE)) throw new Error('Sign-in completed, but plan usage was not granted. Restart, select this account, and enable plan usage when prompted.');
    if (!account.planNoticeSeen) {
      console.log("You're using your ChatGPT plan. Manage this app's plan allowance and credit access at https://chatgpt.com/settings/usage");
      await ask('Got it [Enter]: ');
      account.planNoticeSeen = true;
      await store.save();
    }
    const models = await listModels(await session.accessToken(account));
    models.forEach((m, i) => console.log(`${i + 1}. ${clean(m.name)} (${clean(m.slug)})`));
    const configured = process.env.CHAT_MODEL;
    let model = configured ? models.find(m => m.slug === configured) : undefined;
    if (configured && !model) console.log('CHAT_MODEL is not in this account catalog. Choose an available model.');
    while (!model) {
      const choice = (await ask('Model number: ')).trim();
      if (/^\d+$/.test(choice)) model = models[Number(choice) - 1];
    }
    console.log(`\nActive: ${clean(account.email)} [${clean(account.clientId)}]\nModel: ${clean(model.slug)} | Billing: ChatGPT plan\n`);
    return new OpenAIProvider(readConfig(model.slug), () => session.accessToken(account));
  }
  async function enableIfNeeded(account: Account): Promise<Account> {
    if (account.tokens?.scopes.includes(PLAN_SCOPE)) return account;
    const answer = (await ask('Enable ChatGPT plan usage for this account? [y/N]: ')).trim().toLowerCase();
    if (answer !== 'y') throw new Error('Plan usage remains disabled. No inference was sent.');
    return session.signIn(account, true);
  }
  try {
    await store.load();
    console.log(`Harness Chat | Continue with ChatGPT\nUses your plan allowance and any credits you authorize in ChatGPT settings.\nUsage controls: https://chatgpt.com/settings/usage\n${help}`);
    let account = await enableIfNeeded(await chooseAccount());
    let provider = await chooseModel(account);
    while (!closed) {
      const text = (await ask('you> ')).trim();
      if (!text) continue;
      if (text === '/exit' || text === '/quit') break;
      if (text === '/help') { console.log(help); continue; }
      if (text === '/reset') { provider.reset(); console.log('Conversation cleared.'); continue; }
      if (text === '/usage') { console.log(`${formatUsage(total)}\nCompleted requests only. Plan/credit limits: https://chatgpt.com/settings/usage`); continue; }
      if (text === '/logout') {
        const revoked = await session.logout(account);
        console.log(revoked ? 'Signed out. Renewable session revoked.' : 'Local tokens cleared. Remote revocation was not confirmed; disconnect Harness Chat in ChatGPT settings.');
        break;
      }
      if (text === '/account' || text === '/login') {
        const next = text === '/account' ? await chooseAccount() : await session.signIn(account, !account.tokens?.scopes.includes(PLAN_SCOPE));
        const enabled = await enableIfNeeded(next);
        const nextProvider = await chooseModel(enabled);
        account = enabled; provider = nextProvider;
        console.log('Started a new conversation for the selected account.');
        continue;
      }
      if (text.startsWith('/')) { console.log('Unknown command. Use /help.'); continue; }
      active = new AbortController();
      const start = performance.now();
      process.stdout.write('assistant> ');
      try {
        const result = await provider.send(text, { signal: active.signal, onText: delta => process.stdout.write(clean(delta)) });
        if (result.usage) for (const key of Object.keys(total) as (keyof Usage)[]) total[key] += result.usage[key];
        console.log(`\n[${((performance.now() - start) / 1000).toFixed(1)}s | ${result.usage ? formatUsage(result.usage) : 'usage unavailable'}]\n`);
      } catch (error) {
        console.error(`\n${clean(session.redact(describeError(error)))}\nThis turn was not added to history.\n`);
      } finally { active = undefined; }
    }
  } catch (error) {
    if (!closed) { console.error(clean(session.redact(describeError(error)))); process.exitCode = 1; }
  } finally { input.close(); await store.release(); }
}
main().catch(error => { console.error(clean(describeError(error))); process.exitCode = 1; });
