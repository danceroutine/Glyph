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

Both the desktop host and CLI pin the personal Glyph store's physical location at startup.
The startup profile verifies that identity on access. Ordinary edits to a rule
or skill in the admitted directory remain visible. A profile symlink retarget
leaves the running host on its original directory. Replacing the pinned object
invalidates access.

A skill package change passes through the package manager. Its preview carries
the reviewed revision and, for local intake, the source access check. At publication
the manager checks the source, destination and peer editors again. Ordinary
project edits consult `SkillProjectMutationPolicy` to reserve this workflow for
managed paths.

## Composing a host

Select the consumer's policy through `WorkspaceContentAccess` at the CLI or
desktop composition root. Its project, shell, selected-file and user-catalog
views share the host's reservations. Bind the chosen policy to the attached
directory with `WorkspaceRootAccess`. The disk store and path index use that
root's projection. The operation's `assertCurrent` check belongs immediately
before returning an asynchronous result or performing a write.

For a rule or instruction supplied to a model, carry the identity observed by
the authorized read. `NativePinnedSourceAuthority` checks the physical origins
in a batch. The provider's final synchronous guard checks trust, cancellation
and the private-path generation at the moment of delivery. Keeping the body
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

A file a human deliberately attaches is an explicit input to that request.
Keep its provenance. Automatic expansion of a folder, search hits, and later
tool reads each have their own workspace access requirements.

Native search and restricted shell commands run outside the JavaScript process.
Pass the host's policy to their adapters. The shell view reserves the physical
profile and the staging directory of each attached workspace, including paths
that may be created later. The native helper applies those reservations when
the process starts. To switch profiles, stop commands that could reach the new
location, including detached commands, and restart the host.

## Extending access

Wire the narrowest existing port at composition. If the platform operation is new,
put the adapter beside its domain owner. Describe in the entity's JSDoc what it
decides, how long that decision lasts, and what the caller does after an await,
retry, or change of owner. Exercise the transition through the feature's normal
entry point. The Oxlint workspace-access rule records the production modules
that own raw filesystem, process, and workbench access.
