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

A file a human deliberately attaches is an explicit input to that request.
Keep its provenance. Automatic expansion of a folder, search hits, and later
tool reads each have their own workspace access requirements.

Native search and the shell run outside the JavaScript process. Pass the host's
policy to their adapters. An OS sandbox is established at launch. For an
intentional move of private storage, stop existing commands that could reach the
new location, including detached commands, before switching the boundary.

## Extending access

Wire the narrowest existing port at composition. If the platform operation is new,
put the adapter beside its domain owner. Describe in the entity's JSDoc what it
decides, how long that decision lasts, and what the caller does after an await,
retry, or change of owner. Exercise the transition through the feature's normal
entry point. The Oxlint workspace-access rule records the production modules
that own raw filesystem, process, and workbench access.
