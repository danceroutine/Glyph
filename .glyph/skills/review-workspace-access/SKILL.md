---
name: review-workspace-access
description: Use when reviewing changes to Glyph's filesystem policies, host composition, context disclosure, editor mutations, private storage, or shell confinement.
---

Read the [workspace access guide](../../../docs/WORKSPACE_ACCESS.md). Pick one
production entry point in the diff and follow the actual object graph to its
read, disclosure, write, or spawn. Repeat for any entry point with different
wiring, especially CLI, desktop, worker, and restored-session paths.

1. Identify who owns each decision. Check whether a default constructor, local
   filesystem call, native client, or editor service creates a second route.
   Examine each new lint exemption and confirm the adapter needs that capability.
2. Trace what crosses an async boundary. A search result can be consumed later,
   an approval outlive its window, and a cached body reach a different turn.
   Disconnect and reconnect the initiating window while an operation is queued. The
   prior signal must remain revoked after the new attachment is admitted.
   Locate the last authority check before the effect. Confirm revocation and
   unavailability produce an explicit failure or omission.
3. For path handling, compare aliases and destination paths on the actual volume.
   Check multi-root routing, prospective files, and replacements of the directory
   or file behind a name. For editor writes, include dirty peer windows.
4. For shell changes, trace approval to the actual launcher and account for
   background children. For private storage, identify which physical directory
   the running host protects across ordinary edits and profile path changes.
5. Run a focused regression for the affected contract. Report the entry point,
   intervening change, observable effect, and owning policy. Call out legitimate
   operations that now fail as well as operations that incorrectly succeed.
