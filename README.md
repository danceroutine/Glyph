# Glyph

Glyph is a local-first terminal coding agent that signs in with ChatGPT and works against the project in which it is launched. It can inspect project files, attach selected context to a conversation, stream responses and reasoning summaries, and apply workspace edits immediately, with explicit Keep/Revert review afterward.

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

## Source imports and builds

Cross-directory imports use `#src/*` for application code and `#scripts/*` for
build tooling. Use `.js` in `#src/` specifiers; TypeScript, Vitest, and the `tsx`
development runner resolve them to the corresponding `.ts` or `.tsx` sources.
Same-directory `./` imports remain local. Code OSS uses its own `#vs/*` and
`#glyph/*` aliases, documented in [code-oss/README.md](code-oss/README.md).

Use `pnpm build` to emit JavaScript and declarations. The build resolves source
aliases during TypeScript emission, including dynamic imports and declaration
import types. Desktop packaging uses the same emitter, so compiled artifacts
run without this checkout's source files or package import map. The unit suite
guards against reintroducing parent-relative module imports.

## Features

- ChatGPT account authentication with saved sessions, token refresh, account switching, and logout revocation.
- Streaming assistant responses, summarized reasoning, tool activity, cancellation, and token-usage reporting.
- Fast fuzzy project-file search and `@` attachments from the terminal prompt.
- Project-aware file discovery and exact, revision-pinned reads.
- Project-scoped shell commands with explicit approval, conservative safe-command auto-approval, operating-system-enforced filesystem and network sandboxing, reusable background terminals, interactive input, and output-triggered agent wake-ups.
- Create, update, rename, and delete proposals apply immediately so the agent can run tests, start a server, and iterate before review.
- An arrival-ordered, multi-actor review queue with per-change Keep/Revert decisions, durable recovery, and stale-file protection. `/accept-all` keeps applied changes; `/reject-all` reverts them in reverse order. Revert preserves disjoint later edits and refuses overlapping changes.
- Exact preservation of UTF-8 text, byte-order marks, line endings, final newlines, whitespace, Unicode, and file modes.
- Full-screen terminal review with navigation across files and change blocks, plus a non-interactive fallback.
- Provider tracing with credential redaction and configurable local state storage.
- Offline unit and end-to-end test suites that do not consume OpenAI usage.
- A sample React todo project for exercising project discovery, context attachment, and editing workflows.
