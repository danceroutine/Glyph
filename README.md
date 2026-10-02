# Harness Chat: Sign in with ChatGPT

Version 0.2.0. This replaces the API-key prototype with direct OAuth-based ChatGPT plan usage. It is a local TypeScript terminal app with streaming chat, in-memory conversation history, account/model selection, token refresh, cancellation, and usage reporting.

**No API key, API billing setup, client secret, or separate application registration is required by the documented dynamic-registration flow.** This build has no API-key authentication path. `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL` are not used for requests.

## Start

Use Node 22.18+ (Node 24 recommended). Extract the archive and enter `harness-chat`:

```sh
npm ci
npm start
```

No `.env` is required.

1. Enter `n` to **Continue with ChatGPT**.
2. The app opens your browser on macOS/Linux. If it does not open, copy the displayed authorization URL into your browser on the same machine.
3. Sign in to the ChatGPT account with your subscription, select the intended workspace if prompted, and authorize Harness Chat to use your plan.
4. The browser returns to `127.0.0.1` on a temporary local port. Return to the terminal for identity verification.
5. Acknowledge the first-use plan message, then select a model from the account-specific catalog.
6. Start chatting.

On subsequent launches, choose the saved account number. The app refreshes expired tokens when possible. `/login` reauthorizes the selected registration; `/account` selects another saved registration or adds one. Account changes start a fresh conversation so context does not cross accounts.

## Subscription usage

Eligible requests use the selected ChatGPT account's plan allowance and any credits you permit that app to use in ChatGPT settings. The program does not buy credits or change those settings.

Manage limits and credit access: https://chatgpt.com/settings/usage

To keep the experiment within included usage, review Harness Chat's credit access there and disable it if you do not want the app to consume credits. The subscription's dollar price is not an equivalent dollar balance of API credit.

This route is a preview. Account, workspace, region, model, policy, or service availability can prevent access. An OAuth login alone does not establish inference eligibility: the end-to-end proof is a completed streamed response. **No live user login or subscription inference was performed while building this artifact.**

## Smoke test

Send separately:

```text
Remember the label violet-42. Reply with OK.
```

```text
What label did I ask you to remember?
```

Verify the answer streams and the second reply recalls the label. `/reset` clears conversation context. `/usage` reports API-returned token counts for completed requests and links to plan usage controls. Request a longer answer, press Ctrl+C, and verify you can send the next message.

## Commands

| Command | Behavior |
| --- | --- |
| `/help` | Commands |
| `/reset` | Clear conversation; keep process-wide token totals |
| `/usage` | Completed-request token totals and ChatGPT usage link |
| `/account` | Choose a saved account or add one; clear conversation |
| `/login` | Reauthorize the selected account; clear conversation |
| `/logout` | Attempt refresh-token revocation, clear local tokens, exit |
| `/exit` | Exit, retaining saved login |
| Ctrl+C during generation | Cancel the response; discard the attempted turn |
| Ctrl+C at a prompt or during sign-in | Exit/cancel |

Single-line input only. Wait for a response to finish before entering the next message. No file access, shell tools, editor integration, or disk transcript storage is included.

## Optional configuration

Copy `.env.example` to `.env` only if you want overrides:

```dotenv
# Exact slug from the account's displayed catalog. Omit to choose interactively.
# CHAT_MODEL=
CHAT_TIMEOUT_MS=120000
CHAT_INSTRUCTIONS="You are a helpful assistant. Be clear and concise."
```

Existing environment variables take precedence over `.env`. `CHAT_MODEL` is accepted only when it appears in the selected account's visible model catalog. The subscription route rejects `max_output_tokens`, so this build deliberately omits that setting. The timeout cancels locally; it is not a token or spending cap.

## Credentials and account lifecycle

Credentials and stable host/account registration metadata are stored outside the source tree at:

```text
~/.config/harness-chat-chatgpt/accounts.json
```

`HARNESS_CHAT_CONFIG_DIR` optionally overrides that directory, useful for isolated testing. Use a local private directory, not a shared or synced folder.

Files are written atomically with mode `0600`; the directory uses `0700` on Unix. Tokens are plaintext in this protected file, not encrypted in the OS keychain. This is a prototype storage choice. Windows users should ensure the directory has a private ACL; Unix permission bits do not provide equivalent Windows ACL protection.

The app validates the ID token's signature, issuer, audience, expiration, nonce, and returning account identity. It validates OAuth state, uses PKCE, binds its callback only to `127.0.0.1`, verifies the granted plan scope before inference, and retains each issued client ID separately. It does not read or reuse Codex's credential files.

Refreshes rotate and persist tokens together. A process-wide lock prevents two copies from racing a rotating refresh token. Close one copy before starting another. After an unclean process termination, verify no copy is running, then remove the `session.lock` directory in the credential directory. Keep `accounts.json` to preserve the host and account registrations.

`/logout` attempts remote revocation before clearing tokens and retains the issued client/account mapping for later login. If revocation cannot be confirmed, the terminal tells you to disconnect Harness Chat in ChatGPT settings. `/exit` keeps the renewable session.

## Failure handling

- **Login declined / plan scope missing:** no inference runs. The saved account can explicitly enable plan usage through the sign-in prompt or `/login`.
- **Expired or revoked refresh token:** tokens are cleared, registration retained. Sign in again with `/login` or restart.
- **401:** inspect selected account and granted permissions. Reauthorize if the session was revoked.
- **403 / user not eligible:** the selected account, workspace, policy, or region may not support this preview. Changing local configuration cannot grant eligibility.
- **Usage limit exceeded:** open https://chatgpt.com/settings/usage. The limit may be specific to this app.
- **503 / usage unavailable:** retry later; saved credentials are retained.
- **Interrupted, failed, or incomplete stream:** the attempted turn is excluded from history; partial text may already have appeared.
- **Browser callback fails:** use a browser on the same machine as the terminal, allow the loopback callback, and restart sign-in. Attempts expire after five minutes.
- **Setup/account-switch errors:** restart and select the saved account. Ordinary chat-request errors leave the prompt available.

There are no automatic inference retries or alternate billing routes. Error diagnostics and request IDs are shown when supplied. SDK debug logging is disabled; application error output redacts saved tokens.

## Architecture

- `src/auth/protocol.ts`: PKCE, authorization parameters, callback validation, token exchange, signed identity validation.
- `src/auth/login.ts`: browser handoff and local callback lifecycle.
- `src/auth/store.ts`: protected local state and process lock.
- `src/auth/session.ts`: account registration, refresh, redaction, revocation.
- `src/models.ts`: current account-specific model catalog.
- `src/openai-provider.ts`: streaming Responses adapter and transactional conversation state.
- `src/provider.ts`: interface decoupling the terminal from the provider.
- `src/cli.ts`: account/model picker and chat commands.

Requests go to the documented public `https://api.openai.com/v1` route using the OAuth access token as the bearer credential. This is direct integration, not a wrapper around the Codex agent. `store: false`, `stream: true`, and client-supplied history are used. Full message/reasoning outputs are retained in memory; opaque encrypted reasoning state is replayed. No unsupported max-output or sampling parameters are sent.

## Validation

```sh
npm run check
npm test
```

Strict TypeScript and offline tests cover PKCE and callback rejection, signed ID-token validation, token exchange parameters, restricted credential permissions, process locking, consent gating, serialized refresh/rotation, expired-session recovery, revocation, account model discovery, subscription request shape, multi-turn history, usage, cancellation, and stream failure rollback. Tests generate their own signing keys and inject mock HTTP responses; no user credentials or paid requests are used.

Interactive terminal startup and Ctrl+C exit were also checked. The real browser consent flow and subscription inference remain the local acceptance test.

## Official references (checked 2026-10-01)

- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
