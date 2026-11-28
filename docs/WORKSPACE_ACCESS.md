# Workspace access

Start with the effect the caller needs. The CLI and desktop host compose the
authorities for their attached roots. Feature code receives an operation it can
perform through that host. The details of the backing volume, editor, and native
process belong at the adapter.

| Operation                                                                       | Owner                                                                                    | When to consult it                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Filter agent-visible names and project private host paths into an attached root | `WorkspaceAccessPolicy`                                                                  | At discovery and again before delivering results if its private-path generation changed          |
| Establish physical path or open-file identity                                   | `WorkspacePathAccess` and `NativeFilesystemMetadata`                                     | At the filesystem operation, including the opened handle when the caller has one                 |
| Read authoritative text or apply a revision-checked change                      | `WorkspaceTextStore` implemented by disk and workbench adapters                          | At each call, using the routed root and the revision required by the operation                   |
| List or search workspace files                                                  | `RustWorkspacePathIndex` behind the host's index port                                    | At the query and before releasing a result that crossed an asynchronous boundary                 |
| Select scoped instructions and release them to a model                          | The instruction catalog and turn context session                                         | Scope selects a candidate. Delivery requires current authority over the captured source.         |
| Activate a skill or disclose a package resource                                 | The skill turn contributor and the source authority associated with its captured package | At first activation and when releasing selected resource bytes to the agent                      |
| Admit a window to mutate a workspace                                            | `WorkspaceOwnershipRegistry` and the desktop host                                        | When admitting the connection and when dispatching or completing work on its behalf              |
| Authorize a shell command and launch it                                         | `ShellApprovalPolicy` and the configured `ShellProcessLauncher`                          | Match the command and working directory for approval, then enforce the granted profile at launch |

A desktop command inherits a signal from the window's current workspace attachment.
The desktop host grants access after checking ownership and trust. Its
`WindowCommandAuthority` revokes outstanding commands on disconnect, detach,
trust loss, or a change of roots. Reconnecting issues a fresh signal. Carry the
original signal through approvals and lock waits, then check it alongside the
resource policy before submitting the write or returning data to the window.
Attachment negotiation also belongs to the submitting renderer port. A replacement
port that resumes the same window ID must finish its own handshake before it can
receive a snapshot or run a command. Queued requests from the previous port expire
on disconnect.

When the host asks the workbench to edit a file, the editor RPC router holds
the root, source and destination paths, and window authority for that operation.
The workbench asks the original port to validate those paths again after native
file-operation participants finish. Before saving, it also checks that the open
model and its version still match the edit. Completing the RPC or disconnecting
the port retires its grant, including checks still waiting on the filesystem.

## Composing a host

Select the consumer's policy through `WorkspaceContentAccess` at the CLI or
desktop composition root. Its project, shell, selected-file and user-catalog
views share the host's reservations. Bind the chosen policy to the attached
directory with `WorkspaceRootAccess`. The disk store and path index use that
root's projection. The CLI session and desktop runtime retain selected directory
descriptors in `WorkspaceRootSelections`. Each attached path must still reach
its selected directory through the original route. Merged path and content
searches retain every contributing root's operation through the last page.
The operation's `assertCurrent` check belongs immediately
before returning an asynchronous result or performing a write.

For a rule or instruction supplied to a model, carry the identity observed by
the authorized read. `NativePinnedSourceAuthority` checks the physical origins
in a batch. The provider's final synchronous guard checks trust, cancellation
and the private-path generation, along with the contributing workspace roots, at
the moment of delivery. Keeping the body
selected for the turn lets ordinary content edits take effect on the next turn.

## Choosing the boundary

A normalized path is an address. A revision identifies reviewed content. An
approval records a user's decision about an operation. Each is useful to its
owner, and an operation can require all three. For example, a rename needs
current authority over its source and destination even if a user already
approved the content.

File discovery, cache filling, and model delivery can occur at different times.
Keep the snapshot that was selected, carry its source identity, and consult the
live authority when delivering it. If a source moves into private storage while
a tool or worker is running, the adapter must withhold it. An unrelated edit
should leave the identity of a still-authorized source usable.

For an ordinary project file read, the host checks the captured file’s route at the
first provider handoff and any retry. An atomic save in the same directory preserves
access to the captured text. A new unsaved file stays bound to the live editor and
its admitted workspace path through handoff.

A file a human deliberately attaches is an explicit input to that request.
The CLI keeps every selected root live until the entire attachment batch reaches the
model. Desktop Send, Steer and Git review carry the originating window signal through
queues and provider preparation. A Git comparison contributes the routed paths of
both sides to scoped instruction selection. The captured before and after text,
including explicit selections and unsaved edits, stays at the selected revision.

`WorkspaceDisclosure` retains the access checks returned by the stores and indexes
that supplied the result. The agent checks them after asynchronous instruction lookup
and provider preparation. Folder outlines and comparison resources repeat their live
checks at model handoff, including transport retries. Before the provider receives a protected read, a recovery
checkpoint records its completion and lets the next turn read it again. Steering with
undelivered captures enters provider history after the handoff. These checks belong to the
current turn and stay in host memory.

Native search and the shell run outside the JavaScript process. Pass the host's
policy to their adapters. An OS sandbox is established at launch. For an
intentional move of private storage, stop existing commands that could reach the
new location, including detached commands, before switching the boundary. Glyph verifies the startup profile's directory identity
when issuing a project, selected-file, catalog, or sandbox operation and when a
host-mediated result is delivered. An observed removal or replacement invalidates
outstanding operations and cached projections. New operations resume when the
original directory returns to its enrolled path. A running sandbox keeps the
OS rules installed at launch. External moves between host checks, including
moves during a running command, require the same stop-before-move procedure.

## Extending access

Wire the narrowest existing port at composition. If the platform operation is new,
put the adapter beside its domain owner. Describe in the entity's JSDoc what it
decides, how long that decision lasts, and what the caller does after an await,
retry, or change of owner. Exercise the transition through the feature's normal
entry point. The Oxlint workspace-access rule records the production modules
that own raw filesystem, process, and workbench access.
