# Shell security policy

Glyph's confined shell policy gives a command access to a selected workspace and enough host runtime files to execute development tools. It withholds direct host networking, limits host filesystem writes, and attempts to protect application state, Git metadata, installation files, and identified secrets. Explicit full-access authorization bypasses that confinement.

This document explains the implemented policy and its practical limits, as inspected on October 20, 2026. It focuses on shell execution. Provider authentication, credential storage, native project reads/edits, web tools, and renderer authority have separate enforcement paths. The [shell execution walkthrough](SHELL_EXECUTION.md) contains the actor-by-actor Mermaid sequences; [agent editing](AGENT_EDITING.md) describes the editor mutation boundary.

The source was read in an active shared checkout. No native sandbox probes or integration tests were run for this document. A rule emitted by the policy builder is evidence of intended enforcement, not a demonstration of resistance to every alias, race, host-service interaction, or kernel vulnerability.

**Authority is selected before confinement is constructed.** `ToolExecutor` checks the conversation mode and input before dispatch. Shell execution requires Agent mode. `ShellSessionManager` resolves the working directory and checks terminal ownership, and `ShellCommandAuthorizer` chooses the profile. The operating system then constrains the launched command independently of what the model or command claims it will do.

| Profile           | How it is selected                                                                                | Authority supplied by Glyph                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `READ_ONLY`       | The user enabled safe-command approval and the command qualifies as a fresh foreground inspection | Read permitted host/workspace paths; write temporary storage and selected device endpoints; no workspace write grant |
| `WORKSPACE_WRITE` | Ordinary approval or a saved exact-command/working-directory grant                                | The same baseline reads plus writes in the selected workspace root, subject to protections                           |
| `FULL_ACCESS`     | Explicit outside-sandbox approval or the saved allow-everything policy                            | Direct host-shell execution with the inherited environment, subject to ordinary OS/user permissions                  |

The default approval policy is `ASK`. Saved command grants match the complete trimmed command string and resolved working directory. They are scoped to the project context. The safe-command classifier is an approval convenience: even a misclassified executable must still run within the read-only sandbox. Background commands and existing terminals do not qualify for that automatic safe path.

Ordinary approval authorizes the command's available workspace authority, not a particular predicted diff. A command launched from `src/` can write elsewhere in the granted workspace root. Git metadata and installation protections narrow that authority at specific paths.

There is no confined network-enabled profile. Requesting a command that needs host networking currently requires full-access authorization, which also removes the filesystem restrictions and environment filtering described below.

**The launcher determines the initial scope.** `ShellWorkingDirectoryResolver` resolves project-relative input to a real directory and rejects escape through traversal or symlinks. A multi-root workspace requires a root name. `NativeShellSandboxLauncher` selects the most specific configured root containing that working directory and passes that one root to the helper. The Rust request format supports multiple roots, but the current launcher does not pass every open workspace root.

The native helper independently canonicalizes the working directory, state directory, roots, and explicitly protected paths. It deduplicates roots and protected paths, requires the working directory to belong to a root, and rejects overlap between state and workspace in either direction.

Root validation also rejects:

- The filesystem root, the user's home directory, and ancestors of home.
- Roots containing or contained by a listed home-secret location.
- Exact matches for `/Applications`, `/Library`, `/System`, `/Users/Shared`, `/home`, `/opt`, `/opt/homebrew`, `/private`, `/private/tmp`, `/private/var`, `/root`, `/tmp`, `/usr`, `/usr/local`, and `/var`.

The last list is an exact-root check, not a blanket prohibition on all descendants. The distinction matters when interpreting the authority of a deliberately selected checkout. Canonicalization establishes the paths inspected during setup; it does not establish that every later path identity is immutable.

**Confined commands receive a reduced environment.** The launcher retains `HOME`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`, and variables beginning with `LC_`; it supplies the selected `SHELL`, `TERM=dumb`, and `NO_COLOR=1`. Other inherited variables, including ordinary credential and startup-hook variables, are omitted.

For read-only execution, the executable search path is `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`. Workspace-write preserves the host `PATH`, or uses that fallback. Preserving an executable search path does not add filesystem read grants. It does affect which executable is found inside the authority already granted.

The selector accepts recognized shells resolved under enumerated system/package-manager locations, or falls back to `/bin/sh`. Bash receives `--noprofile --norc`, zsh receives `-f`, and fish receives `--no-config`. These suppress personal startup behavior without proving that every system startup mechanism is absent. The selector checks names, paths, and file existence; it is not an executable signature/provenance verification system.

**macOS enforces access rules on the process.** The helper creates a per-command temporary directory, sets `TMPDIR` to it, and invokes `/usr/bin/sandbox-exec -p <policy> -- <shell> ...`. The policy operates on the host filesystem; Glyph does not assemble a substitute root filesystem on this platform.

The generated Seatbelt profile begins:

```scheme
(version 1)
(deny default)
(deny network*)
```

Default denial makes subsequent grants meaningful. The network denial applies in both confined profiles. Apple documents that child processes inherit the sandbox, and that restrictions generally apply when acquiring resources: an already-open descriptor can remain usable. Glyph intentionally supplies stdin/stdout/stderr pipes, so child communication with the host remains possible. These semantics are described in Apple's installed `sandbox(7)` manual.

The broad read grant uses `file-read*` and `file-test-existence` with recursive `subpath` filters:

| Readable area                     | Exact paths or selection                                                     |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Core system/runtime               | `/System`, `/usr`, `/bin`, `/sbin`, `/Library`                               |
| System configuration/runtime data | `/private/etc`, `/private/var/db`, `/private/var/run`, `/private/var/select` |
| Package-manager trees             | `/opt/homebrew`, `/usr/local`                                                |
| Project                           | The selected workspace root                                                  |
| Temporary files                   | The new per-command temporary directory                                      |
| User toolchains                   | Existing paths from the shared toolchain list below                          |

These grants include data and configuration within those trees. They are broader than permission to execute specific binaries. The separate `(literal "/")` grant addresses the root directory itself; it does not recursively authorize the whole host.

Writes are permitted in the temporary directory for both profiles. Workspace-write adds recursive workspace writes. The builder also emits explicit denials:

| Protected area                             | macOS rule                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Glyph state directory                      | Deny reads and writes under the configured state path                   |
| Listed home secrets                        | Deny reads and writes using literal and recursive path filters          |
| Discovered sensitive workspace files       | Deny reads and writes at each discovered pathname                       |
| `.git` path components                     | Deny writes using a regular expression matching a `.git` path component |
| Discovered Git metadata                    | Deny writes using literal and recursive filters                         |
| Supplied protected paths and native helper | Deny writes using literal and recursive filters                         |

Git and installation protections preserve integrity. They do not generally hide readable Git objects or source code. State and sensitive-file rules additionally aim to preserve confidentiality.

The remaining macOS grants permit runtime facilities:

| Facility                  | Generated permission and scope                                  |
| ------------------------- | --------------------------------------------------------------- |
| Program execution         | `process-exec` and `process-fork`                               |
| Process inspection        | `process-info*` for `same-sandbox` targets                      |
| Signals                   | `signal` for `same-sandbox` targets                             |
| System queries            | `sysctl-read`                                                   |
| Shared memory             | `ipc-posix-shm`                                                 |
| Descriptor paths          | Read data, test existence, and write data under `/dev/fd`       |
| Random sources            | Reads and existence checks for `/dev/random` and `/dev/urandom` |
| Null and terminal devices | Reads and writes for `/dev/null` and `/dev/tty`                 |
| Device metadata           | Metadata reads for `/dev` and paths beneath it                  |
| Named local services      | `mach-lookup` for six explicit service names                    |

An allowed operation still depends on the resource existing and the caller satisfying ordinary OS checks. For example, allowing `/dev/tty` does not create a controlling terminal.

**Mach explains the local-service exception.** Mach supplies foundational kernel abstractions used by macOS, including tasks, threads, virtual memory, and inter-process communication (IPC). In this policy, the relevant abstraction is a Mach port: a kernel-managed messaging endpoint accessed through send/receive rights. A Mach port is not a TCP or UDP port. Programs use it to exchange local messages, often behind a higher-level framework API. Apple's [Mach overview](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/KernelProgramming/Mach/Mach.html) explains these abstractions.

A named service provides a discovery step. The bootstrap service machinery associates a name with a port. A client looks up that name and obtains a send right, then uses the service's protocol to send requests. Apple's [bootstrap interface](https://github.com/apple-oss-distributions/launchd/blob/main/liblaunch/bootstrap.h) documents the name-to-port binding and lookup contract.

For example, a preferences API may need a preferences service. The conceptual steps are: the client looks up the service, the OS checks whether discovery is allowed, the client obtains a messaging right, and the receiving service handles or rejects the subsequent request. This illustrates the boundary; it is not a trace establishing that every Glyph shell command contacts that service.

Glyph's exact lookup allowlist is:

| Service name                              | Service family                        |
| ----------------------------------------- | ------------------------------------- |
| `com.apple.bsd.dirhelper`                 | Helper for special directory creation |
| `com.apple.cfprefsd.agent`                | User preferences services             |
| `com.apple.cfprefsd.daemon`               | System preferences services           |
| `com.apple.CoreServices.coreservicesd`    | CoreServices framework services       |
| `com.apple.system.logger`                 | System logging                        |
| `com.apple.system.opendirectoryd.libinfo` | Directory-information lookup          |

The family descriptions are orientation aids, consistent with the installed Apple daemon manuals (`dirhelper(8)`, `cfprefsd(8)`, `coreservicesd(8)`, `syslogd(8)`, and `opendirectoryd(8)`). They do not enumerate the RPC methods reachable through each endpoint. The policy source does not document a per-command necessity justification for each service or prove that this is the minimum required set.

`mach-lookup` grants discovery of those endpoints. It does not grant unrestricted methods, administrator privileges, or direct access to every file the server can read. The server and OS can apply further checks to messages and callers. However, the server executes with its own authority, outside the command's simple path restrictions. The security boundary therefore includes the behavior of reachable services.

This is why a network-denied process can still interact with local services, and why “no direct network access” should not be expanded into “no communication or mediated effects.” Establishing whether a particular service can perform an unwanted operation for the caller would require separate protocol/authorization evidence; the presence of a lookup grant alone does not establish an exploit.

Apple's installed `sandbox-exec(1)` manual marks the command deprecated and points application developers toward App Sandbox. Glyph currently uses the command/profile mechanism. Dependency lifecycle and compatibility are separate concerns from the correctness of these particular rules.

**Linux constructs a namespace and mount environment.** The helper looks for `/usr/bin/bwrap`, then `/bin/bwrap`, canonicalizes the first existing file, and passes explicit arguments. This avoids selecting Bubblewrap from the inherited `PATH`. It does not independently authenticate the binary or enforce a minimum backend version.

The initial arguments are:

```text
--die-with-parent
--new-session
--unshare-all
--tmpfs /
--dev /dev
--proc /proc
--tmpfs /tmp
```

Bubblewrap constructs the mount namespace. `--unshare-all` additionally requests user and cgroup namespaces where possible, and IPC, PID, network, and UTS namespaces. A namespace gives the child a separate view of the relevant kernel resource; it is not a virtual machine or a separate kernel. Glyph does not pass `--share-net`. `--new-session` detaches from the controlling terminal, and `--die-with-parent` requests termination when Bubblewrap or its parent dies. These option semantics are documented in the [upstream Bubblewrap reference](https://github.com/containers/bubblewrap/blob/main/bwrap.xml); installed-version compatibility was not tested here.

The builder then constructs the filesystem view in order:

1. Read-only bind mounts for existing `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, `/opt`, and `/nix/store`.
2. Read-only bind mounts for existing home toolchain paths.
3. A workspace mount: `--ro-bind` in read-only mode, `--bind` in workspace-write.
4. Read-only mounts over discovered Git metadata and protected paths that lie inside a workspace root.
5. Read-only `/dev/null` mounts over discovered sensitive workspace files.
6. An empty tmpfs over the configured state directory.
7. Conditional masking of listed home-secret locations exposed within workspace roots.
8. `--chdir` to the validated working directory and execution of the supplied shell command.

The broad mounts establish available content; the later overlays change the view at protected paths. A read-only mount withholds writes through that mount but still exposes its data. The writable workspace mount is a view onto the real checkout, so its writes persist on the host.

The root and `/tmp` tmpfs mounts are temporary storage. The state-directory tmpfs hides the original state rather than imposing an access-denied response on its name. A command can potentially create its own files in that temporary view without modifying Glyph's actual state. `READ_ONLY` therefore describes host/workspace write authority, not a global ban on writing anywhere.

Masking a file with `/dev/null` also changes observable behavior: a read normally produces empty content instead of the original bytes. It is not deletion or modification of the original file. This differs from the macOS read denial.

Linux's conditional home-secret masking checks whether the secret path lies under a workspace root. Earlier root validation normally rejects such overlaps. These overlays do not establish that every alias or auxiliary toolchain mount has been checked for secret exposure. Avoid treating the existence of a masking loop as a general confidentiality proof.

Linux protects Git metadata discovered during setup. It has no equivalent to the macOS persistent `.git` pathname-pattern rule. Likewise, discovered mount overlays are not a general rule classifying future paths. The builder does not supply a custom seccomp syscall filter or CPU, memory, process-count, or storage quotas. A cgroup namespace is not a cgroup resource limit.

**Both backends use the same home-path lists.** `home_toolchain_paths()` identifies the following relative paths beneath the canonical home directory. Existing entries are added to the readable filesystem authority:

| Toolchain group       | Paths                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| Rust                  | `.cargo/bin`, `.cargo/git`, `.cargo/registry`, `.rustup/toolchains`        |
| General user binaries | `.local/bin`                                                               |
| Node/runtime managers | `.volta`, `.nvm`, `.asdf`, `Library/Application Support/fnm`, `.cache/fnm` |
| JavaScript tools      | `.bun/bin`, `.pnpm`, `Library/pnpm`, `.cache/node/corepack`                |

These paths may contain cached source, configuration, or other data alongside executables. The policy does not classify their contents as safe merely because they are toolchain paths.

`home_sensitive_paths()` identifies:

| Secret family                   | Paths                                             |
| ------------------------------- | ------------------------------------------------- |
| SSH and cloud credentials       | `.ssh`, `.aws`, `.azure`, `.config/gcloud`        |
| Hosting and orchestration       | `.config/gh`, `.config/glab`, `.kube`             |
| Docker configuration            | `.docker/config.json`                             |
| Package/network/Git credentials | `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials` |
| OS secret stores                | `Library/Keychains`, `.local/share/keyrings`      |

macOS emits explicit denials for these paths. Linux generally does not mount the rest of home and applies the conditional masks described above. Preserving the `HOME` environment variable gives programs a conventional path string; it does not grant access to every path beneath it.

**Workspace secret protection is a bounded startup scan.** The launcher serializes its `WorkspaceAccessPolicy` into the helper request. The current TypeScript defaults are:

| Rule                          | Values                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Exact sensitive names         | `.git-credentials`, `.netrc`, `.npmrc`, `.pypirc`                                        |
| Sensitive prefixes            | `.env`                                                                                   |
| Sensitive suffixes            | `.key`, `.pem`, `.p12`, `.pfx`                                                           |
| Explicit allowed name         | `.env.example`                                                                           |
| Ignored traversal directories | `.artifacts`, `.code-oss`, `.git`, `.next`, `coverage`, `dist`, `node_modules`, `target` |

The native sensitive-name matcher lowercases names and rules and applies the allowed-name exception first. It classifies existing regular files. The traversal skips symlinks and stops descending into ignored directories. Ignored directory-name matching itself uses the configured spelling.

Each traversal permits at most 100,000 entries and depth 64. Exceeding these bounds fails setup. Git metadata discovery uses the same bounded traversal and limits a `.git` pointer file to 4 KiB. It records `.git` paths and resolves `gitdir:` destinations; Linux only adds discovered metadata mounts inside workspace roots, while macOS emits write denials for the discovered paths.

There are several limits to the meaning of “sensitive” here:

- An ignored directory can remain accessible through the workspace grant. Ignoring it during scanning does not block shell access.
- Files created after policy construction are not automatically added to the sensitive-file list.
- An unrecognized filename containing credentials is not detected by content.
- Exempting `.env.example` assumes a naming convention; it does not inspect whether the file contains secrets.
- Protecting a pathname does not prove that the same bytes are unavailable through another hard link, alias, cache, Git object, or already-open descriptor.

These limitations are relevant to the current policy, independently of any additional proposed hardening. They should remain visible when describing what the sandbox promises.

**Installation protection is supplied by composition.** Desktop passes its artifact root as a protected path. CLI passes the package root, context-index executable, and sandbox executable. The native helper also adds its own canonical executable path.

macOS emits write denials for these paths. Linux adds read-only overlays when they lie inside a workspace root; outside that root, their accessibility depends on the other mounts. These are shell-specific rules. They do not establish that native editing tools apply the same installation protection.

**Process lifetime and output are host controls.** `ShellSessionManager` has a default limit of 16 sessions. A foreground wait defaults to 120 seconds. On Unix, termination sends SIGTERM to the process group and schedules SIGKILL after 2 seconds. Cleanup remains scheduled even if the parent exits first. This is not proof that every possible descendant remains in the targeted group.

Background execution returns before completion and does not take the foreground timeout path. Its lifecycle is controlled by terminal close/disposal and the relevant host/backend cleanup. An idle terminal can be reused only by starting another authorized command.

The command output buffer retains the last `256 * 1024` JavaScript string code units and the displayed state tail retains `64 * 1024`. Those constants are implemented with string length/slicing, not byte accounting. They are retention bounds, not limits on total child output or a comprehensive memory budget.

Wake matching uses separate filtered stdout/stderr streams. The retained raw tool output and downstream presentation have different responsibilities; filtering terminal controls does not classify the text as trustworthy model instructions or remove private data. Interactive stdin is restricted to a running command owned by the chat, and raw input to full-access commands is refused.

**Full access is an explicit change of authority.** The launcher bypasses the Rust helper, uses the inherited environment, and invokes the Unix shell with `-lc` or Windows `cmd.exe` with `/d /s /c`. Startup files and variables excluded from the confined path can participate again. Ordinary user/OS restrictions still apply.

Missing or failed native backends do not trigger an automatic full-access retry. Unsupported operating systems receive a sandbox-unavailable error. Windows has an explicit full-access launcher branch but no confined backend in this implementation; this is not a claim of tested Windows support.

**The containment boundary ends at the child process interface.** The utility host remains able to store state, call the provider, operate native project tools, and perform web requests. Data returned by a confined command can enter provider requests and traces. Blocking the child's direct networking therefore does not prevent host-mediated disclosure.

Workspace writes can also affect later consumers such as build scripts, watchers, or subsequent commands. A sandbox profile limits which resources the child may affect directly; it does not make every permitted source/configuration change harmless to a later, more privileged consumer.

The trusted foundation includes the host and its loaded code, native helper, backend executable, OS kernel, filesystem/mount authority, and reachable host services. Reviewing emitted policies and running unit tests can validate construction decisions. Native enforcement, service authorization behavior, races, and deployment compatibility require their own evidence.

The implementation anchors for this reference are [ShellCommandAuthorizer](../src/shell/ShellCommandAuthorizer.ts), [NativeShellSandboxLauncher](../src/shell/NativeShellSandboxLauncher.ts), [ShellWorkingDirectoryResolver](../src/shell/ShellWorkingDirectoryResolver.ts), [WorkspaceAccessPolicy](../src/workspace/policy/WorkspaceAccessPolicy.ts), [ShellSessionManager](../src/shell/ShellSessionManager.ts), and the [Rust request validation and policy builders](../native/shell-sandbox/src/lib.rs). The actor sequence is in [SHELL_EXECUTION.md](SHELL_EXECUTION.md). The existing [static security analysis](SECURITY_STATIC_ANALYSIS.md) records separately identified gaps and hypotheses; it should not be read as native-test certification.
