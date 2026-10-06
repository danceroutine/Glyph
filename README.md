# Glyph

Glyph is a local-first terminal coding agent that signs in with ChatGPT and works against the project in which it is launched. It can inspect project files, attach selected context to a conversation, stream responses and reasoning summaries, and stage workspace edits for explicit review before anything is written.

Glyph uses ChatGPT subscription authentication. It does not require an OpenAI API key, client secret, separate API billing setup, or application registration.

## Installation

Glyph requires:

- Node.js 22.18 or newer
- pnpm 12.8 or newer
- Rust 1.88 or newer

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

## Features

- ChatGPT account authentication with saved sessions, token refresh, account switching, and logout revocation.
- Streaming assistant responses, summarized reasoning, tool activity, cancellation, and token-usage reporting.
- Fast fuzzy project-file search and `@` attachments from the terminal prompt.
- Project-aware file discovery and exact, revision-pinned reads.
- Staged create, update, rename, and delete proposals that never modify the workspace before review.
- An arrival-ordered, multi-actor review queue with per-change decisions, accept-all and reject-all commands, durable recovery, and stale-file protection when actors or collaborators touch the same file.
- Exact preservation of UTF-8 text, byte-order marks, line endings, final newlines, whitespace, Unicode, and file modes.
- Full-screen terminal review with navigation across files and change blocks, plus a non-interactive fallback.
- Provider tracing with credential redaction and configurable local state storage.
- Offline unit and end-to-end test suites that do not consume OpenAI usage.
- A sample React todo project for exercising project discovery, context attachment, and editing workflows.
