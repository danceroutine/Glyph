---
name: implement-workspace-access
description: Use when implementing agent tools, workspace reads or edits, catalog discovery, context delivery, editor operations, or subprocess launches in Glyph.
---

Start at the [workspace access guide](../../../docs/WORKSPACE_ACCESS.md). Trace the
request from the CLI or desktop composition root to the operation that releases
bytes, changes a file, or launches a process. Choose the existing port for that
operation. Inject it at construction so background work and retries inherit the
same host boundary.

- For agent reads, edits and discovery, use the injected workspace store or index.
  Keep the workspace-relative name through routing. Let the adapter bind it to
  the physical object at use. Route each path of a rename through its owning root.
- For delayed context, retain the approved snapshot and its source identity.
  Recheck the source when releasing it to a turn or worker, including when a
  cache supplies the bytes. A filename, catalog ID, or cached grant alone cannot
  authorize a later disclosure.
- For editor-backed data, preserve the user's unsaved content and route
  authorization through the host. Apply mutation checks again when committing,
  including after a prompt, ownership transfer, or async editor request.
- For commands, obtain the shell approval and launch through the configured
  sandbox adapter. Document the boundary the OS enforces for the process's
  lifetime and how the host handles changes to that boundary.
- If an adapter genuinely needs a new privileged import, document its operation
  and lifetime in its JSDoc, add its exact path to the relevant lint rule, and
  add a regression exercising the adapter through a real caller.

Run the smallest relevant test first. For a deferred operation, exercise a change
between selection and use as well as an ordinary edit that should still work.
