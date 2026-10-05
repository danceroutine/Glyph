# Harness Chat: Sign in with ChatGPT

Version 0.2.0. This replaces the API-key prototype with direct OAuth-based ChatGPT plan usage. It is a local TypeScript terminal app with streaming chat, read-only project access, in-memory conversation history, account/model selection, token refresh, cancellation, and usage reporting.

The repository also contains a small React TODO app in `examples/todo-app`. It is a standalone sample project for exercising project-discovery and file-access tools; it is not coupled to the chat runtime.

**No API key, API billing setup, client secret, or separate application registration is required by the documented dynamic-registration flow.** This build has no API-key authentication path. `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL` are not used for requests.

## Start

Use Node 22.18+ (Node 24 recommended). Extract the archive and enter `harness-chat`:

```sh
pnpm install
pnpm start
```

No `.env` is required.

1. Enter `a` to add your first account with **Continue with ChatGPT**.
2. The app opens your browser on macOS/Linux. If it does not open, copy the displayed authorization URL into your browser on the same machine.
3. Sign in to the ChatGPT account with your subscription, select the intended workspace if prompted, and authorize Harness Chat to use your plan.
4. The browser returns to `127.0.0.1` on a temporary local port. Return to the terminal for identity verification.
5. Acknowledge the first-use plan message, then select a model from the account-specific catalog.
6. Start chatting.

### Sample TODO app

Install workspace dependencies, then run the Vite development server:

```sh
pnpm install
pnpm todo:dev
```

The app supports adding, completing, filtering, and deleting tasks, and keeps its state in browser local storage. Use `pnpm todo:build` to produce a production build.

On subsequent launches, choose the saved account number—or press Enter when there is only one. Choosing `a` always starts authorization for another account or workspace. The app refreshes expired tokens when possible. `/login` reauthorizes the selected registration; `/account` selects another saved registration or adds one. Account changes start a fresh conversation so context does not cross accounts.

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

Then ask a codebase question that requires discovery, for example:

```text
Where does the sample TODO app persist its tasks, and what happens if the saved data is invalid?
```

The agent should discover and read the relevant files before answering.

## Commands

| Command | Behavior |
| --- | --- |
| `/help` | Commands |
| `/reset` | Clear conversation; keep process-wide token totals |
| `/usage` | Completed-request token totals and ChatGPT usage link |
| `/trace [on\|off]` | Show or toggle complete provider trace logging |
| `/account` | Choose a saved account or add one; clear conversation |
| `/login` | Reauthorize the selected account; clear conversation |
| `/logout` | Attempt refresh-token revocation, clear local tokens, exit |
| `/exit` | Exit, retaining saved login |
| Ctrl+C during generation | Cancel the response; discard the attempted turn |
| Ctrl+C at a prompt or during sign-in | Exit/cancel |

Single-line input only. Wait for a response to finish before entering the next message. No shell tools, write tools, editor integration, or disk transcript storage is included.

## Project access

The directory where `pnpm start` is launched is the project root. The model can call two read-only functions: one lists project files and one reads a UTF-8 file or line range. Every invocation is shown as a `[tool> ...]` line followed by its `[tool< ... completed]` or error status. Function calls and outputs are kept in the in-memory conversation so follow-up questions retain the evidence already gathered.

Project access skips dependency, VCS, coverage, and build-output directories; symlinks; `.env` variants other than `.env.example`; common credential files; and private-key formats. Reads cannot escape the project root, default to at most 512 KiB files and 100 lines per call, and stop after eight consecutive tool rounds. The discovery, read, and exclusion defaults are private supporting details in `ProjectAccess.ts`; callers can override them through the constructor's options object. File contents returned by a tool are sent to OpenAI as conversation input.

## Optional configuration

Copy `.env.example` to `.env` only if you want overrides:

```dotenv
# Exact slug from the account's displayed catalog. Omit to choose interactively.
# CHAT_MODEL=
CHAT_TIMEOUT_MS=120000
CHAT_INSTRUCTIONS="You are a helpful assistant. Be clear and concise."
CHAT_TRACE=1
# CHAT_TRACE_FILE=/absolute/path/to/harness-trace.log
```

Existing environment variables take precedence over `.env`. `CHAT_MODEL` is accepted only when it appears in the selected account's visible model catalog. The subscription route rejects `max_output_tokens`, so this build deliberately omits that setting. The timeout cancels locally; it is not a token or spending cap.

Full provider tracing is on by default during this prototype phase. Structured JSON Lines entries include the exact Responses request body, HTTP response metadata, every parsed SSE event, terminal response, tool calls and results, usage accumulation, and committed or discarded history. The shared HTTP client also records request timing, status, and failures without recording request headers or bodies. The CLI writes these entries to `~/.config/harness-chat-chatgpt/harness-trace.log`; `HARNESS_CHAT_CONFIG_DIR` relocates the default alongside the rest of the harness state, while `CHAT_TRACE_FILE` overrides the path directly. Access tokens and credential-bearing headers are redacted; project content and opaque encrypted reasoning are not. The log and its parent state directory use private Unix permissions. Use `/trace off` for the current session or `CHAT_TRACE=0` at startup to disable full provider traces. Concise tool activity remains visible in the terminal.

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

There are no automatic inference retries or alternate billing routes. Full provider traces and request IDs are logged by default. SDK debug logging is disabled; application output redacts saved tokens and credential-bearing headers.

## Architecture

Source is organized by domain. A file has one primary exported symbol and its filename matches that symbol's casing. Tests are colocated one layer below their subject in a domain-local `tests/` directory.

- `src/application/HarnessService.ts`: headless application facade for account lifecycle, model discovery, conversation creation, aggregate usage, and trace policy.
- `src/chat/ChatConversation.ts`: mutable history and request handling for one host-owned chat session. Separate conversations do not share provider history.
- `src/chat/`: host-neutral request/response, model catalog, provider factory, trace, tool-activity, and usage contracts.
- `src/configuration/`: host-facing configuration contract plus the CLI environment adapter.
- `src/http/FetchHttpClient.ts`: typed GET/POST transport, body encoding, timeouts, and telemetry-safe request instrumentation.
- `src/observability/`: general-purpose logger contract plus file and no-op adapters.
- `src/project/ProjectAccess.ts`: root-confined project discovery and bounded text-file reads.
- `src/providers/openai/`: OpenAI integration, including ChatGPT-plan model discovery and streaming Responses behavior.
- `src/providers/openai/auth/OpenAIAuthenticationClient.ts`: PKCE authorization, callback validation, token exchange/parsing, identity verification, refresh, and revocation.
- `src/providers/openai/auth/OpenAISession.ts`: OpenAI account/session lifecycle behind an application-facing port.
- `src/shared/mappers/` and `src/shared/validators/`: genuinely shared `toX` mappers and `isX` validators.
- `src/terminal/`: the terminal host adapter, including prompts, slash commands, rendering, browser launch, and signal handling.
- `src/cli.ts`: composition root only; it creates concrete dependencies and owns process lifecycle.

### VS Code compatibility audit

The headless boundary follows VS Code's request-driven shape rather than modeling the terminal prompt loop as the application API:

- A host creates a `ChatConversation` for each chat session, then supplies a prompt, response stream, and cancellation signal for each turn. This avoids global selected-model/history state and permits concurrent editor sessions.
- `ChatResponsePart` is an enum-discriminated stream that the terminal renders today. A VS Code adapter can translate text to `ChatResponseStream.markdown` and tool activity to progress without introducing a `vscode` dependency into the core.
- Account/model selection is host-owned. A VS Code adapter can use Quick Pick, its authentication UI, `SecretStorage`, and the selected request model instead of emulating terminal questions.
- `ConfigurationProvider` deliberately separates behavior from its source. The CLI implementation reads environment variables; a VS Code implementation can read `workspace.getConfiguration(...)` and react to `onDidChangeConfiguration`.
- Credentials are not treated as ordinary settings. `FileOpenAIAccountStore` is the CLI adapter; a VS Code adapter can persist token-bearing state through `SecretStorage` and non-secret state through extension storage.
- `Logger` mirrors the `trace`, `debug`, `info`, `warn`, and `error` shape of VS Code's `LogOutputChannel`, while the CLI uses `FileLogger`.
- Constructor-injected ports (`OpenAIAccountStore`, `OpenAISessionService`, `ModelCatalog`, `ChatProviderFactory`, `ConfigurationProvider`, `HttpClient`, and `Logger`) can be registered behind VS Code service identifiers when this code moves into the fork.
- OAuth authorization is a host callback, so VS Code can use `env.openExternal`; cancellation is request-scoped and can be bridged from a VS Code `CancellationToken` to an `AbortController`.

The current `OpenAIProvider` is still an agent orchestrator: it executes project tools internally and emits user-facing tool activity. If the integration is implemented specifically as a VS Code `LanguageModelChatProvider`, the transport and tool loop must be split so raw `LanguageModelToolCallPart` and `LanguageModelToolResultPart` values can be handed back to VS Code. That is an explicit future seam, not something hidden behind the terminal abstraction.

Official API references checked for this boundary:

- https://code.visualstudio.com/api/extension-guides/ai/chat
- https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider
- https://code.visualstudio.com/api/extension-guides/ai/tools
- https://code.visualstudio.com/api/references/vscode-api
- https://code.visualstudio.com/api/extension-capabilities/common-capabilities
- https://github.com/microsoft/vscode/wiki/Source-Code-Organization

Requests go to the documented public `https://api.openai.com/v1` route using the OAuth access token as the bearer credential. This is direct integration, not a wrapper around the Codex agent. `store: false`, `stream: true`, and client-supplied history are used. Full message, reasoning, function-call, and function-output items are retained in memory; opaque encrypted reasoning state is replayed. Tool-round usage is accumulated into the reported turn total. No unsupported max-output or sampling parameters are sent.

## Validation

```sh
pnpm run check
pnpm test
# During development:
pnpm run test:watch
```

Strict TypeScript and offline colocated Vitest tests cover PKCE and callback rejection, signed ID-token validation, token exchange parameters, restricted credential permissions, process locking, consent gating, serialized refresh/rotation, expired-session recovery, revocation, account model discovery, subscription request shape, project path confinement, function-call continuation, multi-turn history, usage, cancellation, and stream failure rollback. Tests generate their own signing keys and inject mock HTTP responses; no user credentials or paid requests are used.

Interactive terminal startup and Ctrl+C exit were also checked. The real browser consent flow and subscription inference remain the local acceptance test.

## Official references (checked 2026-10-02)

- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
- https://developers.openai.com/api/docs/guides/function-calling
