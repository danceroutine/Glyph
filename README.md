# Glyph

Glyph is a desktop IDE that brings together the best agent workflows from Cursor and Codex. It is built on Code OSS, the open-source foundation of Visual Studio Code, with the coding agent built directly into the workbench. Chat, context capture, command approvals, and edit review all use the editor's own views, diffs, and keybindings.

Glyph is designed around bringing your own provider account. You sign in with the AI account you already pay for, and your requests go to that provider under your existing plan. OpenAI is supported today through Continue with ChatGPT, which uses your ChatGPT subscription directly in place of an API key. Anthropic and other providers are on the roadmap.

## Features

### An agent that lives in the editor

- Chat in the secondary sidebar with tabs and searchable history. Each conversation keeps the account and model it started with.
- Streaming responses with expandable reasoning summaries, live tool progress, and per-conversation token usage.
- Agent mode for doing the work and Plan mode for designing it first. Plans open as native documents with rendered Markdown and Mermaid diagrams, and **Build** hands the reviewed plan and its todos to the agent.
- A todo card above the composer that tracks the agent's progress through multi-step work.
- When the agent needs a decision, it asks through an inline form with choices and room for your own answer.

### Context from where you already are

- Type `@` to attach workspace files, press Cmd+L (Ctrl+L) to attach editor or terminal selections, or use **Add File to Glyph Chat** and **Add Directory to Glyph Chat** from the Explorer.
- **Fix with Agent** on diagnostic hovers and failed tests starts a prompt with the exact error attached.
- The agent reads and searches your live editor buffers, including unsaved changes, so it always sees the code you are looking at.
- Select text in a chat, a plan, or a proposed change to leave a comment that travels with your next message.

### Edits you can review after the fact

- The agent's edits apply and save immediately, so it can run tests, start a development server, and iterate without waiting on you.
- Every change, including file creation, rename, and deletion, stays in a review queue until you **Keep** or **Revert** it from a native inline diff, one change or one file at a time.
- Revert restores the previous content while preserving your own later edits to other parts of the file, and refuses to touch lines you have changed since.
- Applied edits also remain undoable through the editor's ordinary Undo.

### Commands that run in a sandbox

- Shell commands run inside an operating-system-enforced filesystem and network sandbox, with inline Run, Skip, and Always Run approvals.
- Long-running commands such as dev servers continue in the background, accept interactive input, and can be stopped from the chat.

### Research and review

- Web search and page fetch, with every source listed in the transcript. Fetched content reaches the agent labeled as untrusted evidence.
- **Agent Review** in Source Control reviews the last commit, staged changes, all local changes, or a comparison against a branch. Findings stay attached to their lines, and **Fix All Issues** sends them to the active chat.

### A full IDE underneath

- The Code OSS editor, language tooling, debugger, integrated terminal, and settings, with extensions available through Open VSX.
- Conversations, pending reviews, and remembered command approvals survive window reloads and host restarts. Interrupted work is shown as interrupted and waits for you to retry it.

## Installation

Packaged builds of Glyph are coming soon, starting with signed macOS releases. In the meantime, you can build and run Glyph from source by following [Development setup](#development-setup).

## Roadmap

The next milestones broaden which providers and tools the agent can use, deepen what it knows about your project, and make Glyph installable as an ordinary application.

- **More providers**, starting with Anthropic, alongside the existing OpenAI support.
- **MCP servers**, configurable by you or by the agent, with tool discovery, resources, and prompts.
- **Skills, rules, and `AGENTS.md`**, so project and personal instructions shape the agent's behavior automatically.
- **Sub-agents** that run blocking or background tasks on the main agent's behalf.
- **Browser integration** for previewing your app in the editor, letting the agent drive and inspect pages, and anchoring comments to page elements.
- **Smarter context**, including conversation compaction for long sessions and retrieval backed by language servers.
- **Lifecycle hooks** for sessions, tool calls, and edits.
- **Tab completion** for inline suggestions while you type.
- **Settings and keybindings** that expose the rest of Glyph's options and let you rebind composer shortcuts.
- **Distribution** through signed and notarized installers, automatic updates, and Linux and Windows builds.

## Development setup

### Prerequisites

- Node.js 22.18 or newer
- pnpm 12.8 or newer
- Rust 1.88.0, which `rustup` selects automatically from `rust-toolchain.toml`
- macOS, or Linux with [Bubblewrap](https://github.com/containers/bubblewrap) installed, for sandboxed shell commands
- The native build tools that Code OSS itself requires, listed in the [VS Code contributor prerequisites](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites)

The Code OSS scripts download and use their own pinned Node.js runtime, so your system Node.js only needs to satisfy Glyph's requirement.

### Build and launch

Clone the repository and install its dependencies:

```sh
git clone https://github.com/danceroutine/Glyph.git
cd Glyph
pnpm install --frozen-lockfile
```

Build the Glyph host, then download, install, and compile the pinned Code OSS release with Glyph's overlay applied:

```sh
pnpm desktop:artifact
pnpm code-oss:bootstrap
pnpm code-oss:install
pnpm code-oss:compile
```

Launch the editor with isolated profile and extension directories:

```sh
pnpm code-oss:launch -- --user-data-dir ../user-data --extensions-dir ../extensions
```

On first launch, open the Glyph sidebar, choose to add an account, complete Continue with ChatGPT in your browser, and pick a model. No `.env` file is required; the optional settings are documented in `.env.example`.

After changing Glyph's host code, rerun `pnpm desktop:artifact`. After changing the workbench overlay or UI, rerun `pnpm code-oss:compile`.

### Working on the UI in a browser

The sidebar's Preact components run in Storybook with simulated conversations, so you can iterate on the interface without building or launching Code OSS:

```sh
pnpm storybook
```

Then open http://127.0.0.1:6006 and start with **Glyph / Chat / Workbench / Interactive**.

### Checks and tests

Component tests run in headless Chromium, which Playwright installs once:

```sh
pnpm exec playwright install chromium
```

Then run the checks and the full test suite:

```sh
pnpm check
pnpm test
```

`pnpm check` runs formatting, linting, Rust checks, and type checks. `pnpm test` builds the editor and runs the Rust, unit, component, and Electron integration suites with coverage enforcement. Every suite uses local fixtures and scripted provider responses, so testing never spends model usage. To rerun only the Electron integration suite against an already compiled editor, use `pnpm code-oss:test:integration`.

### Further reading

- [code-oss/README.md](code-oss/README.md) covers how Glyph integrates with Code OSS, including the overlay, the workbench UI conventions, and the design system.
- [code-oss/tests/electron/README.md](code-oss/tests/electron/README.md) explains the integration test runtimes and how to run individual behaviors.
- [docs/code-oss-integration-plan.md](docs/code-oss-integration-plan.md) records the architecture behind the desktop host, the editor adapter, and process ownership.
