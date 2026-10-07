# Glyph

Glyph is a local-first terminal coding agent that signs in with ChatGPT and works against the project in which it is launched. It can inspect project files, attach selected context to a conversation, stream responses and reasoning summaries, and stage workspace edits for explicit review before anything is written.

Glyph uses ChatGPT subscription authentication. It does not require an OpenAI API key, client secret, separate API billing setup, or application registration.

## Installation

Glyph requires:

- Node.js 22.18 or newer
- pnpm 12.8 or newer
- Rust 1.88 or newer
- macOS, or Linux with [Bubblewrap](https://github.com/containers/bubblewrap) installed, for sandboxed shell commands

Clone the repository and install its dependencies:

```sh
git clone https://github.com/<your-github-username>/Glyph.git
cd Glyph
pnpm install --frozen-lockfile
```

Start Glyph from the project checkout:

```sh
pnpm start
```

On first launch, choose the option to add an account, complete Continue with ChatGPT in the browser, and select an available model. No `.env` file is required. Optional configuration values are documented in `.env.example`.

Sandboxed commands fail closed when the native sandbox backend is unavailable. They use the configured shell executable when it resolves to a trusted system or package-manager location, while deliberately skipping personal shell startup files and removing credential-bearing environment variables. The user's ordinary `PATH` is retained for explicitly approved project-write commands; conservative read-only commands receive a fixed trusted `PATH` instead.

The separate **Allow outside sandbox** choices use the configured login shell and full inherited environment, including credentials. They deliberately run with the same authority as your user account and should be reserved for commands that genuinely require host or network access.

## Features

- ChatGPT account authentication with saved sessions, token refresh, account switching, and logout revocation.
- Streaming assistant responses, summarized reasoning, tool activity, cancellation, and token-usage reporting.
- Fast fuzzy project-file search and `@` attachments from the terminal prompt.
- Project-aware file discovery and exact, revision-pinned reads.
- Project-scoped shell commands with explicit approval, conservative safe-command auto-approval, operating-system-enforced filesystem and network sandboxing, reusable background terminals, interactive input, and output-triggered agent wake-ups.
- Staged create, update, rename, and delete proposals that never modify the workspace before review.
- An arrival-ordered, multi-actor review queue with per-change decisions, accept-all and reject-all commands, durable recovery, and stale-file protection when actors or collaborators touch the same file.
- Exact preservation of UTF-8 text, byte-order marks, line endings, final newlines, whitespace, Unicode, and file modes.
- Full-screen terminal review with navigation across files and change blocks, plus a non-interactive fallback.
- Provider tracing with credential redaction and configurable local state storage.
- Offline unit and end-to-end test suites that do not consume OpenAI usage.
- A sample React todo project for exercising project discovery, context attachment, and editing workflows.
