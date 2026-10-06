# Cursor IDE Agent Tools

This document lists every tool the Cursor IDE exposes to its agent, excluding tools that come from user-installed MCP servers, extensions, and plugins (GitKraken/GitLens, Figma, GitHub).

Tools fall into four groups:

1. **Core tools** are called directly by name.
2. **Built-in Cursor tools** live in the `cursor` namespace and are called through `CallDynamicTool`.
3. **Browser tools** live in the `cursor-ide-browser` namespace, a Cursor-owned browser tab.
4. **Cursor Origin tools** live in the `cursor-origin` namespace, Cursor's git host. These are Cursor-provided but connect over MCP like a userland server, so treat this section as borderline.

## About the contracts

Input contracts are transcribed from the JSON Schemas the IDE publishes for each tool. Field descriptions are condensed.

No tool publishes a formal output schema. The output contracts below are drawn from each tool's documentation and observed behavior, so treat them as descriptive rather than guaranteed. Every tool can also return an error string instead of its normal result, for example when a path does not exist, a permission check rejects the call, or an approval is declined.

Several tools that reach outside the workspace accept the same two approval fields. They are listed once here and referred to as the **approval fields** below:

| Field                      | Type    | Required    | Notes                                                                                                              |
| -------------------------- | ------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `requestSmartModeApproval` | boolean | no          | Retry an identical call after Auto-review blocked it, asking the user to approve through the native approval card. |
| `smartModeBlockReason`     | string  | conditional | The exact block reason from the prior rejection. Required when `requestSmartModeApproval` is true.                 |

---

## 1. Core tools

### `Shell`

Executes a command in a zsh shell session.

| Field                         | Type    | Required    | Notes                                                                                                                                         |
| ----------------------------- | ------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`                     | string  | yes         | The command to run.                                                                                                                           |
| `description`                 | string  | no          | Short label shown in the UI.                                                                                                                  |
| `working_directory`           | string  | no          | Absolute path. Defaults to the workspace root.                                                                                                |
| `block_until_ms`              | number  | no          | How long to wait before backgrounding the command. Default `30000`. `0` backgrounds immediately.                                              |
| `notify_on_output`            | object  | no          | `{ pattern: string, reason: string, debounce_ms?: number }`. Notifies the agent when output matches `pattern`. `debounce_ms` minimum is 5000. |
| `request_smart_mode_approval` | boolean | no          | Same meaning as `requestSmartModeApproval`.                                                                                                   |
| `smart_mode_block_reason`     | string  | conditional | Same meaning as `smartModeBlockReason`.                                                                                                       |

**Output:** If the command finishes within `block_until_ms`, returns the combined stdout and stderr plus the exit code. If it is still running, returns a shell id and the path of a terminal output file that keeps updating. Large output is written to a file and the path is returned instead of the text.

### `Glob`

Finds files by glob pattern. Patterns that do not start with `**/` get it prepended.

| Field              | Type   | Required | Notes                                                         |
| ------------------ | ------ | -------- | ------------------------------------------------------------- |
| `glob_pattern`     | string | yes      | For example `*.ts` or `**/test/**/test_*.ts`.                 |
| `target_directory` | string | no       | Absolute directory to search. Defaults to the workspace root. |

**Output:** A header of the form `Result of search in '<dir>' (total N files):` followed by one matching path per line, sorted by modification time with the most recent first.

### `Grep`

Searches file contents with ripgrep.

| Field              | Type                                               | Required | Notes                                                                   |
| ------------------ | -------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `pattern`          | string                                             | yes      | Regular expression in ripgrep syntax.                                   |
| `path`             | string                                             | no       | File or directory. Defaults to the workspace root.                      |
| `glob`             | string                                             | no       | File filter, for example `*.{ts,tsx}`.                                  |
| `type`             | string                                             | no       | ripgrep file type, for example `ts` or `py`.                            |
| `output_mode`      | `"content"` \| `"files_with_matches"` \| `"count"` | no       | Default `content`.                                                      |
| `-A` / `-B` / `-C` | number                                             | no       | Context lines after, before, or around each match. `content` mode only. |
| `-i`               | boolean                                            | no       | Case-insensitive. Default false.                                        |
| `multiline`        | boolean                                            | no       | Lets patterns span lines and `.` match newlines. Default false.         |
| `head_limit`       | number                                             | no       | Caps matches (`content`) or files (other modes).                        |
| `offset`           | number                                             | no       | Skips the first N entries, for pagination.                              |

**Output:** In `content` mode, ripgrep-style lines grouped by file, with `:` marking match lines and `-` marking context lines. In `files_with_matches` mode, a list of paths. In `count` mode, a match count per file. Very large results are truncated and reported as "at least" counts.

### `Read`

Reads a file from the local filesystem.

| Field    | Type    | Required | Notes                                                          |
| -------- | ------- | -------- | -------------------------------------------------------------- |
| `path`   | string  | yes      | Absolute path.                                                 |
| `offset` | integer | no       | 1-indexed start line. Negative values count back from the end. |
| `limit`  | integer | no       | Number of lines to read.                                       |

**Output:** Text files come back with every line prefixed as `LINE_NUMBER|content`, the number right-aligned to six characters. Images (jpeg, png, gif, webp) are attached as images. PDFs are converted to text. An empty file returns `File is empty.`, and a missing file returns an error.

### `StrReplace`

Replaces an exact string in a file.

| Field         | Type    | Required | Notes                                                         |
| ------------- | ------- | -------- | ------------------------------------------------------------- |
| `path`        | string  | yes      | Absolute path.                                                |
| `old_string`  | string  | yes      | Must match exactly and be unique unless `replace_all` is set. |
| `new_string`  | string  | yes      | Must differ from `old_string`.                                |
| `replace_all` | boolean | no       | Replace every occurrence. Default false.                      |

**Output:** A success confirmation, or an error when `old_string` is not found or matches more than once without `replace_all`.

### `Write`

Creates a file or overwrites an existing one.

| Field      | Type   | Required | Notes               |
| ---------- | ------ | -------- | ------------------- |
| `path`     | string | yes      | Absolute path.      |
| `contents` | string | yes      | Full file contents. |

**Output:** A success confirmation.

### `AskQuestion`

Shows the user one or more multiple-choice questions. The user can always pick "Other" and type an answer.

| Field       | Type          | Required | Notes                                                                                                                      |
| ----------- | ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `title`     | string        | no       | Title of the form.                                                                                                         |
| `questions` | array (min 1) | yes      | Each item is `{ id: string, prompt: string, options: { id: string, label: string }[] (min 2), allow_multiple?: boolean }`. |

**Output:** The user's answers keyed by question id: the selected option id or ids, or free text when they choose "Other".

### `GetDynamicTools`

Discovers tools in dynamic namespaces such as MCP servers and the `cursor` namespace.

| Field       | Type   | Required | Notes                                                            |
| ----------- | ------ | -------- | ---------------------------------------------------------------- |
| `namespace` | string | no       | Namespace to inspect.                                            |
| `toolName`  | string | no       | One tool in that namespace. Requires `namespace`.                |
| `pattern`   | string | no       | RE2 regex over namespace and tool names, at most 256 characters. |

With no fields, returns the full catalog.

**Output:** JSON of the form `{ mode, namespace, namespaceStatus, namespaceDescription, tools: [{ tool, description, inputSchema }] }`. `namespaceStatus` is one of `ready`, `needsAuth`, `error`, or `loading`. Pattern and catalog modes shorten long descriptions to 200 characters ending in `... [truncated]`. Large responses are written to a file and returned as `{ note, filePath }`.

### `CallDynamicTool`

Invokes one tool from a dynamic namespace.

| Field        | Type   | Required    | Notes                                                                                                                                               |
| ------------ | ------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`  | string | yes         | For example `cursor` or `cursor-ide-browser`.                                                                                                       |
| `toolName`   | string | yes         | The tool to call.                                                                                                                                   |
| `arguments`  | object | no          | Arguments matching the target tool's input schema.                                                                                                  |
| `mcpDetails` | object | conditional | Only for external MCP namespaces, never for `cursor`. `{ description: string, requestSmartModeApproval?: boolean, smartModeBlockReason?: string }`. |

**Output:** Whatever the target tool returns.

---

## 2. Built-in Cursor tools (`cursor` namespace)

### `AwaitShell`

Polls a backgrounded shell job, or sleeps when no shell id is given.

| Field                  | Type    | Required    | Notes                                                                               |
| ---------------------- | ------- | ----------- | ----------------------------------------------------------------------------------- |
| `shell_id`             | string  | conditional | The shell to poll. Required when `block_until_ms` is `0`.                           |
| `block_until_ms`       | number  | no          | Maximum wait. Default `30000`, maximum `7140000` (119 minutes).                     |
| `pattern`              | string  | no          | JavaScript regex compiled with the `m` flag. Returns early when the output matches. |
| `waiting_for_subagent` | boolean | no          | Flags that the wait is for a subagent.                                              |

**Output:** The job's status: whether it is still running or finished, recent output, and the exit code and elapsed time once it completes. Without `shell_id`, returns after the full sleep.

### `CreateGoal`

Creates a long-running goal. Only used when the user explicitly asks for one.

| Field       | Type   | Required | Notes                   |
| ----------- | ------ | -------- | ----------------------- |
| `objective` | string | yes      | At least one character. |

**Output:** A confirmation that the goal was created.

### `UpdateGoal`

Changes the status of the current goal. Pausing is controlled by the user and is not available here.

| Field    | Type                       | Required | Notes |
| -------- | -------------------------- | -------- | ----- |
| `status` | `"active"` \| `"complete"` | yes      |       |

**Output:** A confirmation of the new status.

### `Delete`

Deletes a file.

| Field  | Type   | Required | Notes          |
| ------ | ------ | -------- | -------------- |
| `path` | string | yes      | Absolute path. |

**Output:** A success confirmation. Fails gracefully with a message when the file does not exist, the deletion is rejected for security reasons, or the file cannot be deleted.

### `EditNotebook`

Edits or creates one Jupyter notebook cell.

| Field             | Type    | Required | Notes                                                                                         |
| ----------------- | ------- | -------- | --------------------------------------------------------------------------------------------- |
| `target_notebook` | string  | yes      | Relative or absolute path.                                                                    |
| `cell_idx`        | number  | yes      | 0-based cell index.                                                                           |
| `is_new_cell`     | boolean | yes      | `true` inserts a new cell at `cell_idx`.                                                      |
| `cell_language`   | string  | yes      | One of `python`, `markdown`, `javascript`, `typescript`, `r`, `sql`, `shell`, `raw`, `other`. |
| `old_string`      | string  | yes      | Text to replace, unique within the cell. Empty when creating a cell.                          |
| `new_string`      | string  | yes      | Replacement text or the new cell's content.                                                   |

**Output:** A confirmation of the edit. Cell deletion is not supported, but an empty `new_string` clears a cell.

### `FetchMcpResource`

Reads a resource from an MCP server.

| Field           | Type   | Required | Notes                                                                              |
| --------------- | ------ | -------- | ---------------------------------------------------------------------------------- |
| `server`        | string | yes      | MCP server identifier.                                                             |
| `uri`           | string | yes      | Resource URI.                                                                      |
| `downloadPath`  | string | no       | Workspace-relative path. When set, the resource is saved to disk and not returned. |
| approval fields |        | no       | See the top of the document.                                                       |

**Output:** The resource contents, or a confirmation that it was written to `downloadPath`.

### `GenerateImage`

Generates an image from a text description. Only used when the user explicitly asks for an image.

| Field                   | Type                                                  | Required | Notes                                                                |
| ----------------------- | ----------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `description`           | string                                                | yes      | Detailed description of the image.                                   |
| `filename`              | string                                                | no       | File name only, without a directory. Defaults to a timestamped name. |
| `reference_image_paths` | string[]                                              | no       | Reference images to use as inputs.                                   |
| `aspect_ratio`          | `"1:1"` \| `"4:3"` \| `"3:4"` \| `"16:9"` \| `"9:16"` | no       |                                                                      |

**Output:** The saved image's path. The client displays the image automatically.

### `ReadLints`

Reads linter and diagnostic errors from the workspace.

| Field   | Type     | Required | Notes                                                   |
| ------- | -------- | -------- | ------------------------------------------------------- |
| `paths` | string[] | no       | Files or directories. Omit to read the whole workspace. |

**Output:** Diagnostics grouped by file, each with a severity, location, and message. Returns a no-errors message when there are none.

### `SwitchMode`

Asks to switch the agent's interaction mode. The user must approve.

| Field            | Type                  | Required | Notes                                                |
| ---------------- | --------------------- | -------- | ---------------------------------------------------- |
| `target_mode_id` | `"plan"` \| `"agent"` | yes      | Debug and Ask modes exist but cannot be switched to. |
| `explanation`    | string                | no       | Reason shown to the user.                            |

**Output:** Whether the user approved or declined the switch.

### `Task`

Launches a subagent.

| Field               | Type                   | Required | Notes                                                                       |
| ------------------- | ---------------------- | -------- | --------------------------------------------------------------------------- |
| `description`       | string                 | yes      | Short title shown in the UI.                                                |
| `prompt`            | string                 | yes      | The full task. The subagent cannot see the parent conversation.             |
| `subagent_type`     | string                 | no       | For example `generalPurpose`, `explore`, `browser-use`, `best-of-n-runner`. |
| `model`             | string                 | no       | Model slug from the available list. Cannot be combined with `resume`.       |
| `resume`            | string                 | no       | Agent id to send a follow-up to, or `"self"` to fork the current agent.     |
| `interrupt`         | boolean                | no       | Interrupt a running agent targeted by `resume`.                             |
| `file_attachments`  | string[]               | no       | Images or videos to attach.                                                 |
| `environment`       | `"local"` \| `"cloud"` | no       | Default `local`. `cloud` runs on its own VM and branch.                     |
| `cloud_base_branch` | string                 | no       | Base branch for a cloud subagent. Must exist on the remote.                 |
| `run_in_background` | boolean                | no       | Returns immediately and notifies the parent on completion.                  |

**Output:** In the foreground, the subagent's final message and its agent id. In the background, an agent id and output file path, followed by a completion notification later.

### `TodoWrite`

Creates or updates the session's todo list.

| Field   | Type          | Required | Notes                                                                                                             |
| ------- | ------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `todos` | array (min 2) | yes      | Each item is `{ id: string, content: string, status: "pending" \| "in_progress" \| "completed" \| "cancelled" }`. |
| `merge` | boolean       | yes      | `true` merges by `id`. `false` replaces the whole list.                                                           |

**Output:** A confirmation along with the resulting list.

### `WebFetch`

Fetches a public URL and converts it to markdown. It runs on an isolated server, so localhost, private IPs, authenticated pages, and binary content do not work.

| Field           | Type   | Required | Notes                        |
| --------------- | ------ | -------- | ---------------------------- |
| `url`           | string | yes      | Fully formed URL.            |
| approval fields |        | no       | See the top of the document. |

**Output:** The page as markdown, possibly from a cache. Non-200 responses return an error message instead of content.

### `WebSearch`

Searches the web.

| Field         | Type   | Required | Notes                                     |
| ------------- | ------ | -------- | ----------------------------------------- |
| `search_term` | string | yes      | The query.                                |
| `explanation` | string | no       | One sentence on why the search is needed. |

**Output:** A summary of the search results along with the relevant URLs.

---

## 3. Browser tools (`cursor-ide-browser` namespace)

Almost every browser tool accepts these two optional fields, so they are omitted from the tables below:

| Field                        | Type    | Notes                                                                                                                                                                              |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewId`                     | string  | Target tab id. Defaults to the last tab the agent interacted with.                                                                                                                 |
| `take_screenshot_afterwards` | boolean | Take a screenshot after the action. Default false. Not available on `browser_get_bounding_box`, `browser_highlight`, `browser_lock`, `browser_tabs`, or `browser_take_screenshot`. |

`browser_tabs` takes neither field.

Element `ref` values come from the most recent `browser_snapshot` and are opaque handles. Content inside iframes cannot be reached.

### `browser_navigate`

Navigates to a URL, reusing the current tab unless told otherwise.

| Field      | Type                   | Required | Notes                                                                           |
| ---------- | ---------------------- | -------- | ------------------------------------------------------------------------------- |
| `url`      | string                 | yes      |                                                                                 |
| `newTab`   | boolean                | no       | Open a new tab first. Default false.                                            |
| `position` | `"active"` \| `"side"` | no       | Only set when the user wants the browser shown. Omit for background automation. |

**Output:** A confirmation with the resulting page and tab, plus a screenshot if requested.

### `browser_tabs`

Lists, creates, closes, or selects tabs.

| Field      | Type                                           | Required    | Notes                                                                              |
| ---------- | ---------------------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `action`   | `"list"` \| `"new"` \| `"close"` \| `"select"` | yes         |                                                                                    |
| `index`    | number                                         | conditional | Required for `select`. Optional for `close`, where it defaults to the current tab. |
| `position` | `"active"` \| `"side"`                         | no          | Only for `new`.                                                                    |

**Output:** For `list`, the open tabs with their index, view id, URL, and title. For the other actions, a confirmation.

### `browser_lock`

Locks or unlocks the tab so the user cannot interact while the agent works. A tab must already exist. The user can still click "Take Control" to unlock it.

| Field    | Type                   | Required | Notes |
| -------- | ---------------------- | -------- | ----- |
| `action` | `"lock"` \| `"unlock"` | yes      |       |

**Output:** A confirmation of the lock state.

### `browser_snapshot`

Captures an accessibility snapshot of the page.

| Field         | Type    | Required | Notes                                                                    |
| ------------- | ------- | -------- | ------------------------------------------------------------------------ |
| `interactive` | boolean | no       | Only include interactive elements. Default false.                        |
| `maxDepth`    | number  | no       | Default 20.                                                              |
| `compact`     | boolean | no       | More compact format. Default false.                                      |
| `selector`    | string  | no       | CSS selector that scopes the snapshot to a subtree.                      |
| `includeDiff` | boolean | no       | Include a diff against the previous snapshot of this tab. Default false. |

**Output:** A YAML accessibility tree. Each element carries a `ref` that the action tools accept. This is the main source of truth for page structure.

### `browser_take_screenshot`

Takes a screenshot of the page or an element.

| Field      | Type    | Required | Notes                                                                 |
| ---------- | ------- | -------- | --------------------------------------------------------------------- |
| `type`     | string  | no       | Image format. Default `png`.                                          |
| `filename` | string  | no       | Default `page-{timestamp}.{png\|jpeg}`.                               |
| `element`  | string  | no       | Description of the element being captured.                            |
| `ref`      | string  | no       | Selector for the element being captured.                              |
| `fullPage` | boolean | no       | Capture the full scrollable page. Cannot be combined with an element. |

**Output:** The image is attached so the agent can see it, and it is saved to `filename`.

### `browser_click`

Clicks an element.

| Field                 | Type                                                                          | Required | Notes                                         |
| --------------------- | ----------------------------------------------------------------------------- | -------- | --------------------------------------------- |
| `ref`                 | string                                                                        | yes      |                                               |
| `element`             | string                                                                        | no       | Human-readable description.                   |
| `offsetX` / `offsetY` | number                                                                        | no       | Offset from the element's center.             |
| `doubleClick`         | boolean                                                                       | no       |                                               |
| `button`              | `"left"` \| `"right"` \| `"middle"`                                           | no       | Default `left`.                               |
| `modifiers`           | array of `"Control"` \| `"Shift"` \| `"Alt"` \| `"Meta"` \| `"ControlOrMeta"` | no       |                                               |
| `holdDurationMs`      | number                                                                        | no       | How long to hold the button before releasing. |

**Output:** A confirmation, plus a screenshot if requested.

### `browser_mouse_click_xy`

Clicks at viewport coordinates. `browser_click` with a ref is preferred.

| Field    | Type                                | Required | Notes           |
| -------- | ----------------------------------- | -------- | --------------- |
| `x`      | number                              | yes      |                 |
| `y`      | number                              | yes      |                 |
| `button` | `"left"` \| `"right"` \| `"middle"` | no       | Default `left`. |

**Output:** A confirmation, plus a screenshot if requested.

### `browser_type`

Types text into an input, textarea, or contenteditable element.

| Field     | Type    | Required | Notes                         |
| --------- | ------- | -------- | ----------------------------- |
| `ref`     | string  | yes      |                               |
| `text`    | string  | yes      |                               |
| `element` | string  | no       |                               |
| `clear`   | boolean | no       | Clear existing text first.    |
| `submit`  | boolean | no       | Press Enter afterwards.       |
| `slowly`  | boolean | no       | Type one character at a time. |

**Output:** A confirmation, plus a screenshot if requested.

### `browser_fill`

Sets an element's value directly instead of typing it.

| Field     | Type   | Required | Notes |
| --------- | ------ | -------- | ----- |
| `ref`     | string | yes      |       |
| `value`   | string | yes      |       |
| `element` | string | no       |       |

**Output:** A confirmation, plus a screenshot if requested.

### `browser_select_option`

Selects options in a `<select>` element.

| Field     | Type     | Required | Notes                    |
| --------- | -------- | -------- | ------------------------ |
| `ref`     | string   | yes      |                          |
| `values`  | string[] | yes      | Option values or labels. |
| `element` | string   | no       |                          |

**Output:** A confirmation, plus a screenshot if requested.

### `browser_press_key`

Presses a key using DOM keyboard events.

| Field | Type   | Required | Notes                                                                     |
| ----- | ------ | -------- | ------------------------------------------------------------------------- |
| `key` | string | yes      | For example `Enter`, `Escape`, `Tab`, `ArrowDown`, or a single character. |

**Output:** A confirmation, plus a screenshot if requested.

### `browser_scroll`

Scrolls the page or a container, or scrolls an element into view. No fields are required.

| Field               | Type                                        | Required | Notes                        |
| ------------------- | ------------------------------------------- | -------- | ---------------------------- |
| `ref`               | string                                      | no       | Element or scroll container. |
| `direction`         | `"up"` \| `"down"` \| `"left"` \| `"right"` | no       |                              |
| `amount`            | number                                      | no       | Pixels. Default 300.         |
| `deltaX` / `deltaY` | number                                      | no       | Explicit scroll deltas.      |
| `scrollIntoView`    | boolean                                     | no       | Scroll `ref` into view.      |

**Output:** A confirmation, plus a screenshot if requested.

### `browser_drag`

Drags an element to another element or to viewport coordinates.

| Field                 | Type   | Required | Notes                                            |
| --------------------- | ------ | -------- | ------------------------------------------------ |
| `sourceRef`           | string | yes      |                                                  |
| `targetRef`           | string | no       | Target element.                                  |
| `targetX` / `targetY` | number | no       | Target coordinates, used instead of `targetRef`. |

**Output:** A confirmation, plus a screenshot if requested.

### `browser_get_bounding_box`

Gets an element's position in the viewport.

| Field     | Type   | Required | Notes |
| --------- | ------ | -------- | ----- |
| `ref`     | string | yes      |       |
| `element` | string | no       |       |

**Output:** The element's bounding box: x, y, width, and height in viewport coordinates.

### `browser_highlight`

Highlights an element on the page.

| Field        | Type   | Required | Notes         |
| ------------ | ------ | -------- | ------------- |
| `ref`        | string | yes      |               |
| `element`    | string | no       |               |
| `durationMs` | number | no       | Default 2000. |

**Output:** A confirmation.

### `browser_cdp`

Sends a raw Chrome DevTools Protocol command to the tab. `Input.*` methods are denied, as are browser-wide, storage, cookie, permission, download, target-management, file-input, navigation-history, and system-level commands.

| Field    | Type   | Required | Notes                                                                           |
| -------- | ------ | -------- | ------------------------------------------------------------------------------- |
| `method` | string | yes      | For example `Runtime.evaluate`, `DOM.getDocument`, or `Performance.getMetrics`. |
| `params` | object | no       | CDP params. Omit or pass `{}` when there are none.                              |

**Output:** The CDP command's JSON result. Large responses and profiler output (`Profiler.stop`) are written to a file and returned as a file path. Device emulation set through `Emulation.*` resets at the end of the agent's turn.

---

## 4. Cursor Origin tools (`cursor-origin` namespace)

These tools can only see repositories hosted on [Origin](https://origin.cursor.com), Cursor's git host. GitHub owners and repositories are not reachable.

Unless a tool says otherwise, it requires these two fields, which are omitted from the tables below:

| Field   | Type   | Notes                                                                            |
| ------- | ------ | -------------------------------------------------------------------------------- |
| `owner` | string | Origin namespace slug, taken from `list_namespaces` or an earlier Origin result. |
| `name`  | string | Repository name within that namespace.                                           |

All inputs reject unknown properties (`additionalProperties: false`). Outputs are JSON objects. Paginated tools accept `pageSize` (number) and `pageToken` (string) and return a `nextPageToken` while more results remain.

### Auth

#### `mcp_auth`

Authenticates the Origin MCP server. It takes no input fields, including no `owner` or `name`.

**Output:** The authentication result. Afterwards the namespace status should be `ready`.

### Repositories

#### `list_namespaces`

Lists the namespaces the caller can list repositories in, ordered by slug. It does not take `owner` or `name`.

| Field                    | Type | Required | Notes       |
| ------------------------ | ---- | -------- | ----------- |
| `pageSize` / `pageToken` |      | no       | Pagination. |

**Output:** A paginated list of namespace slugs, each with `viewerCanCreateRepositories`. An empty list means the caller has no readable Origin repositories.

#### `list_repositories`

Lists repositories for an owner. It requires `owner` but not `name`.

| Field                    | Type   | Required | Notes                                              |
| ------------------------ | ------ | -------- | -------------------------------------------------- |
| `owner`                  | string | yes      |                                                    |
| `filter`                 | string | no       | Case-insensitive substring of the repository name. |
| `pageSize` / `pageToken` |        | no       | Pagination.                                        |

**Output:** A paginated list of repositories.

#### `get_repository`

Gets one repository. Takes only `owner` and `name`.

**Output:** The repository, including its default branch and mirror state.

#### `create_repository`

Creates an empty repository. `owner` is optional here, and omitting it uses (and on first use claims) the caller's personal namespace. Needs user confirmation before calling.

| Field           | Type   | Required | Notes                                                            |
| --------------- | ------ | -------- | ---------------------------------------------------------------- |
| `name`          | string | yes      | Unique per owner.                                                |
| `owner`         | string | no       | Must be a namespace where `viewerCanCreateRepositories` is true. |
| `defaultBranch` | string | no       | Default `main`.                                                  |

**Output:** The created repository, including `cloneUrl`. Retrying after success returns a conflict.

### Code and history

#### `get_file_contents`

Reads one path at a ref.

| Field                   | Type   | Required | Notes       |
| ----------------------- | ------ | -------- | ----------- |
| `path`                  | string | yes      |             |
| `ref`                   | string | no       |             |
| `startLine` / `endLine` | number | no       | Line range. |

**Output:** For a file, its content, truncated past a byte cap. For a directory, `type: "dir"` with `entries` for its immediate children (`name`, `path`, `type`, `sha`, and `size` for files) instead of content, and `truncated` set if entries were dropped.

#### `get_git_tree`

Lists a git tree.

| Field       | Type    | Required | Notes                                                    |
| ----------- | ------- | -------- | -------------------------------------------------------- |
| `sha`       | string  | yes      | Tree SHA, commit SHA, branch, tag, or `HEAD`.            |
| `recursive` | boolean | no       | Walk the whole tree. Default is immediate children only. |

**Output:** Entries with `path`, `mode`, `type` (`blob`, `tree`, or `commit`), `sha`, and `size` for blobs. `truncated` is set when entries past the cap were dropped.

#### `grep_contents`

Searches file contents across a repository. There is no pagination, so narrow the query to reach other matches.

| Field                            | Type     | Required | Notes                                                |
| -------------------------------- | -------- | -------- | ---------------------------------------------------- |
| `query`                          | string   | yes      | Case-sensitive regex by default.                     |
| `ref`                            | string   | no       | Defaults to the default branch.                      |
| `literal`                        | boolean  | no       | Match exact text.                                    |
| `caseInsensitive`                | boolean  | no       |                                                      |
| `wholeWord`                      | boolean  | no       | Only applies with `literal`. Use `\b` in regex mode. |
| `contextBefore` / `contextAfter` | number   | no       | At most 10 each.                                     |
| `filterPath`                     | string   | no       | File or directory relative to the repository root.   |
| `includes` / `excludes`          | string[] | no       | Path globs. An exclude beats an include.             |
| `maxResults`                     | number   | no       | At most 1000. `0` uses the default of 1000.          |

**Output:** Matching lines in full, plus any requested context lines. `limitHit` is set when the 1000-occurrence cap is reached.

#### `list_branches`

Lists branches.

| Field                    | Type   | Required | Notes                                                                                                                 |
| ------------------------ | ------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `prefix`                 | string | no       | Case-sensitive prefix, applied per page after pagination. A page can be empty while `nextPageToken` is still present. |
| `pageSize` / `pageToken` |        | no       | Pagination.                                                                                                           |

**Output:** A paginated list of branch names with their tip commit SHAs.

#### `list_commits`

Lists commits from a branch or starting ref.

| Field                    | Type     | Required | Notes                                                       |
| ------------------------ | -------- | -------- | ----------------------------------------------------------- |
| `ref`                    | string   | no       | Branch or starting commit.                                  |
| `authorEmails`           | string[] | no       | Exact, case-insensitive. At most 100.                       |
| `committerEmails`        | string[] | no       | Exact, case-insensitive. At most 100.                       |
| `since` / `until`        | string   | no       | Inclusive RFC 3339 bounds on committer time.                |
| `pageSize` / `pageToken` |          | no       | Continuation calls reuse the filters stored in `pageToken`. |

**Output:** A paginated list of commits, each with `sha`, the full message, author, committer, parents, and tree. Patches are omitted. Filters share a scan of at most 1000 commits per page, so a filtered page can be short or empty while `nextPageToken` is still present.

#### `commit_read`

Reads one commit through a single view.

| Field                    | Type   | Required | Notes                            |
| ------------------------ | ------ | -------- | -------------------------------- |
| `sha`                    | string | yes      |                                  |
| `view`                   | string | yes      | `metadata`, `files`, or `patch`. |
| `pageSize` / `pageToken` |        | no       | Pagination.                      |
| `startLine` / `endLine`  | number | no       | Bounds for the patch view.       |

**Output:** The requested view: commit metadata, the list of changed files, or a bounded patch.

#### `compare_commits`

Compares two refs relative to their merge base.

| Field  | Type   | Required | Notes                           |
| ------ | ------ | -------- | ------------------------------- |
| `base` | string | yes      | Ref the comparison starts from. |
| `head` | string | yes      | Ref compared against the base.  |

**Output:** The comparison between the two refs: the commits and changes on `head` since the merge base.

### Pull requests

#### `list_pull_requests`

Lists pull requests.

| Field                    | Type   | Required | Notes                                                                                    |
| ------------------------ | ------ | -------- | ---------------------------------------------------------------------------------------- |
| `state`                  | string | no       | `open` (default), `closed`, or `all`.                                                    |
| `head`                   | string | no       | Head branch.                                                                             |
| `base`                   | string | no       | Base branch, short name or `refs/heads/…`.                                               |
| `author`                 | string | no       | Actor id (`user_…`, `app_…`, or `sa_…`).                                                 |
| `stackId`                | string | no       | `stk_…`. Lists only that stack's members. Pass `state: "all"` to include merged members. |
| `sortBy`                 | string | no       | `created` (default) or `updated`.                                                        |
| `direction`              | string | no       | `desc` (default) or `asc`.                                                               |
| `pageSize` / `pageToken` |        | no       | Continuation calls must resend the filters.                                              |

**Output:** A paginated list of compact summaries with author, timestamps, `merged`, `closedAt`, `mergedAt`, and stack membership when stacked. Body and diff stats are omitted. With `stackId`, items come in the requested sort order rather than stack order, so the tree has to be rebuilt from each member's `stack.parent`.

#### `pull_request_read`

Reads one pull request through a single view.

| Field                    | Type     | Required    | Notes                                                               |
| ------------------------ | -------- | ----------- | ------------------------------------------------------------------- |
| `number`                 | number   | yes         |                                                                     |
| `view`                   | string   | yes         | `summary`, `files`, `commits`, `reviews`, `comments`, or `threads`. |
| `threadIds`              | string[] | conditional | Required for the `threads` view.                                    |
| `pageSize` / `pageToken` |          | no          | Pagination.                                                         |
| `startLine` / `endLine`  | number   | no          | Line range.                                                         |

**Output:** The requested view. `summary` includes labels, requested reviewers, and stack membership (stack id and parent pull request). `comments` includes the stable comment ids and `threadId` values that other tools take. `threads` pages the comments in the given threads.

#### `create_pull_request`

Creates a pull request from an already-pushed branch.

| Field              | Type    | Required    | Notes                                                                                           |
| ------------------ | ------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `title`            | string  | yes         |                                                                                                 |
| `head`             | string  | yes         | Already-pushed source branch.                                                                   |
| `base`             | string  | conditional | Required unless `parentPullNumber` is set. With it, omit this or name the parent's head branch. |
| `body`             | string  | no          |                                                                                                 |
| `draft`            | boolean | no          |                                                                                                 |
| `parentPullNumber` | number  | no          | Stack on this pull request. Its head branch becomes the base.                                   |

**Output:** The created pull request, with `stackParent` when stacked and `needsRestack` when the head has fallen behind the parent. A head built off trunk or unrelated history is rejected with the rebase to run. This tool never restacks.

#### `update_pull_request`

Updates title, description, and lifecycle.

| Field    | Type                   | Required | Notes                                                                                              |
| -------- | ---------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `number` | number                 | yes      |                                                                                                    |
| `title`  | string                 | no       | Omit to leave unchanged.                                                                           |
| `body`   | string                 | no       | Omit to leave unchanged. `""` clears it.                                                           |
| `state`  | `"open"` \| `"closed"` | no       | `closed` ignores `draft`. `open` reopens and, without `draft: true`, marks the pull request ready. |
| `draft`  | boolean                | no       | `true` reopens as a draft. `false` marks ready and reopens a closed pull request.                  |

**Output:** The updated pull request. Fields are applied in a fixed order, so a failure can leave some of them applied. Re-read after an error. `merged` cannot be written.

#### `update_pull_request_base`

Retargets the base branch, or stacks and unstacks the pull request. Send `base` or `parentPullNumber`.

| Field              | Type   | Required    | Notes                                                                                                                        |
| ------------------ | ------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `number`           | number | yes         |                                                                                                                              |
| `base`             | string | conditional | The head branch of an open pull request stacks onto it. The default branch, or a branch with no open pull request, unstacks. |
| `parentPullNumber` | number | conditional | Stack on this pull request.                                                                                                  |

**Output:** The stored base and head refs, plus `stackParent` when stacked and `needsRestack` when the branch has fallen behind. No commits are rebased.

#### `merge_pull_request`

Merges a pull request, or the stack from its root up to it.

| Field             | Type                    | Required | Notes                                           |
| ----------------- | ----------------------- | -------- | ----------------------------------------------- |
| `number`          | number                  | yes      |                                                 |
| `expectedHeadSha` | string                  | yes      | Guards against merging a head that has changed. |
| `mergeMethod`     | `"merge"` \| `"squash"` | no       | Defaults to the repository's setting.           |

**Output:** The merge result. `skippedDescendants` is currently always empty, and descendants above a mid-stack merge stay open.

### Reviews

#### `create_pull_request_review`

Submits a review. Inline review comments are not supported here; use `create_pull_request_inline_comment`.

| Field    | Type   | Required | Notes                                       |
| -------- | ------ | -------- | ------------------------------------------- |
| `number` | number | yes      |                                             |
| `event`  | string | yes      | `COMMENT`, `APPROVE`, or `REQUEST_CHANGES`. |
| `body`   | string | no       |                                             |

**Output:** The submitted review, including its id.

#### `update_pull_request_review`

Corrects the body of an existing review.

| Field      | Type   | Required | Notes |
| ---------- | ------ | -------- | ----- |
| `number`   | number | yes      |       |
| `reviewId` | string | yes      |       |
| `body`     | string | yes      |       |

**Output:** The updated review.

#### `dismiss_pull_request_review`

Dismisses a submitted approval or request-changes review.

| Field      | Type   | Required | Notes                               |
| ---------- | ------ | -------- | ----------------------------------- |
| `number`   | number | yes      |                                     |
| `reviewId` | string | yes      |                                     |
| `message`  | string | yes      | Reason recorded with the dismissal. |

**Output:** The dismissed review.

#### `request_pull_request_reviewers`

Requests reviewers.

| Field    | Type     | Required | Notes                                          |
| -------- | -------- | -------- | ---------------------------------------------- |
| `number` | number   | yes      |                                                |
| `users`  | string[] | no       | Public `user_…` ids or emails.                 |
| `groups` | string[] | no       | Public `grp_…` ids, qualified slugs, or slugs. |

**Output:** The pull request's updated requested reviewers.

#### `remove_pull_request_reviewers`

Removes requested reviewers. Takes the same fields as `request_pull_request_reviewers`.

**Output:** The pull request's updated requested reviewers.

### Comments and threads

#### `create_pull_request_comment`

Posts a general discussion comment.

| Field    | Type   | Required | Notes |
| -------- | ------ | -------- | ----- |
| `number` | number | yes      |       |
| `body`   | string | yes      |       |

**Output:** The created comment, including its id.

#### `create_pull_request_inline_comment`

Posts a comment on a file, a line, or a line range.

| Field           | Type   | Required | Notes                                                                                                                                                                                                                                                                                            |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `number`        | number | yes      |                                                                                                                                                                                                                                                                                                  |
| `body`          | string | yes      |                                                                                                                                                                                                                                                                                                  |
| `anchor`        | object | yes      | `{ kind: "file" \| "line" \| "range", path: string, side?: "left" \| "right", startLine?: number, endLine?: number }`. `side` and `startLine` are required for `line` and `range`. `endLine` is required for `range` only. `path` is the deleted path for deletions and the head path otherwise. |
| `versionNumber` | number | no       | Pull request version. Omit or `0` for the latest.                                                                                                                                                                                                                                                |

**Output:** The created comment and its thread id.

#### `update_pull_request_comment`

Corrects an existing comment's body. It does not take a pull request number.

| Field       | Type   | Required | Notes                                                        |
| ----------- | ------ | -------- | ------------------------------------------------------------ |
| `commentId` | string | yes      | Stable id from `pull_request_read` with the `comments` view. |
| `body`      | string | yes      |                                                              |

**Output:** The updated comment.

#### `reply_pull_request_review_thread`

Replies to a review thread.

| Field      | Type   | Required | Notes                                            |
| ---------- | ------ | -------- | ------------------------------------------------ |
| `number`   | number | yes      |                                                  |
| `threadId` | string | yes      | From `threadId` on `pull_request_read` comments. |
| `body`     | string | yes      |                                                  |

**Output:** The created reply.

#### `update_pull_request_review_thread`

Resolves or reopens a review thread. It does not take a pull request number.

| Field      | Type    | Required | Notes                                           |
| ---------- | ------- | -------- | ----------------------------------------------- |
| `threadId` | string  | yes      |                                                 |
| `resolved` | boolean | yes      | `true` resolves the thread. `false` reopens it. |

**Output:** The thread's updated resolution state.

### Labels and checks

#### `create_label`

Creates a repository label so it can be applied to pull requests.

| Field         | Type   | Required | Notes                                                          |
| ------------- | ------ | -------- | -------------------------------------------------------------- |
| `label`       | string | yes      | 1 to 50 characters, unique by exact case-sensitive spelling.   |
| `color`       | string | no       | Six hex digits with an optional leading `#`. Default `ededed`. |
| `description` | string | no       | At most 255 characters.                                        |

**Output:** The created label. A name that already exists returns a conflict.

#### `update_pull_request_labels`

Replaces every label on a pull request. It never creates labels.

| Field    | Type     | Required | Notes                                                                                                      |
| -------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `number` | number   | yes      |                                                                                                            |
| `labels` | string[] | yes      | The complete set of existing label names. Omitted names are removed, and an empty list removes all labels. |

**Output:** The pull request's resulting labels.

#### `checks_read`

Reads checks for one target.

| Field                    | Type   | Required | Notes                                                                                                                                                                                                |
| ------------------------ | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`                 | object | yes      | `{ type: string, number?: number, sha?: string, checkSuiteId?: string, checkRunId?: string }`. `type` selects a pull request, commit, suite, or run, and the matching identifier field goes with it. |
| `pageSize` / `pageToken` |        | no       | Pagination.                                                                                                                                                                                          |

**Output:** A paginated list of check runs with a rollup of the current page. The rollup is omitted when `nextPageToken` is present. External provider logs are not fetched.
