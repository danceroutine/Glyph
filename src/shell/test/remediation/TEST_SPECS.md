# Automated remediation suite specifications

These are implementation specifications. Test names below are proposed; no test bearing these names is asserted to exist. All runtime work depends on the controller and safety gates in [PLAN.md](PLAN.md). The [coverage matrix](COVERAGE.md) supplies one concrete case and oracle for every vector.

## Shared acceptance contract

Expected authority comes from the separately reviewed [authority contract](authority-contract.json), not generated policy output. Its unresolved decisions block pass/closure and native admission for the affected cells. The [catalog](coverage.json) declares platform/backend/profile cells and single-operation native designs. A native result applies only to its matching cell; P09/P10 cannot close F2, and K14 TCP evidence cannot cover other network classes. Residual risk is recorded separately from a passing regression.

Every suite must include a passing allowed-operation control, an independently stated rejection/disclosure oracle, a safe known-bad control or justified non-mutability, deterministic fixture/seed provenance, and an explicit evidence lane. Bad controls run only against pure/mock behavior or disposable trusted test copies; never mutate a live security boundary. A crashed or equivalent mutant is not credited as detected authority loss.

For each native-capable vector, implement unit/fixture cases first. Use two separate cells for macOS and Linux where relevant and do not infer one from the other. Native cases must be individually allowlisted; the broader suite may also contain static-only vectors.

## S01 — Backend and executable origin

**Vectors:** L01, L02, L03, L04, L08, L09. **Findings:** F1. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** Only a validated trusted backend/executable identity may run before confinement; backend failure never widens authority.

**Implementation seams:** `src/shell/NativeShellSandboxLauncher.ts`, `src/cli.ts`, `native/shell-sandbox/src/lib.rs`.

**Named tests to implement:** `BackendOriginContract`, `LaunchEnvironmentContract`, `UnavailableBackendFailsClosed`.

**Adversarial cases:**

1. Try to make an inert launch plan choose a workspace search entry instead of its trusted absolute backend.
2. Vary mocked executable ownership, alias identity, replacement epoch, helper override, and startup-hook environment.
3. Remove or mismatch the backend in a fake launcher and check that no FULL_ACCESS retry is requested.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Substitute PATH lookup for a trusted absolute backend, remove ownership checks, or add an unsandboxed fallback in a pure launch-plan mutant.

**Safety/fidelity limit:** No replacement backend, shell startup hook, package script, dependency binary, or downloaded program is executed. Provenance/supply-chain compromise beyond the modeled origin contract remains static.

**Agent packet:** [S01 prompt](prompts/s01-launcher-trust.md).

## S02 — Git metadata and mount authority

**Vectors:** P03, P09, P10. **Findings:** F2. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** Repository metadata must never create new host read authority; protected metadata must remain immutable under the specified project contract.

**Implementation seams:** `native/shell-sandbox/src/lib.rs`, `native/shell-sandbox/tests/sandbox_e2e.rs`.

**Named tests to implement:** `GitMetadataAuthorityBound`, `GitMetadataProtectionContract`, `GitHistoryConfidentialityContract`.

**Adversarial cases:**

1. Make a synthetic .git pointer refer to the forbidden sibling fixture and inspect the parsed Linux mount graph.
2. Vary relative pointers, missing targets, aliases, duplicate roots, nested .git directories, and inert commondir/bare-repository descriptions.
3. For separately registered native cases, attempt only one marker creation in an existing fixture .git directory or one synthetic-history canary read; never invoke real Git tooling or mutate repository metadata.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Add an unapproved sibling target to a fake mount graph or omit one metadata write protection; require the corresponding authority oracle to detect it.

**Safety/fidelity limit:** Pointer-derived mount expansion is policy/fixture-only until independently reviewed; no native F2 escape attempt. New/aliased Git layouts are simulated unless a registered fixed fixture case exists.

**Agent packet:** [S02 prompt](prompts/s02-git-metadata.md).

## S03 — Path identity, roots, and read grants

**Vectors:** L06, P01, P02, P07, P08, P11, P12, P15. **Findings:** F3, F5. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** Canonical roots and additional grants stay within explicitly approved authority; sensitive/trusted overlap is rejected in either direction.

**Implementation seams:** `src/shell/ShellWorkingDirectoryResolver.ts`, `native/shell-sandbox/src/lib.rs`.

**Named tests to implement:** `MacPathReadScope`, `SensitiveRootOverlap`, `CanonicalPathAuthority`, `PathIdentityChangeContract`.

**Adversarial cases:**

1. Represent traversal, prefix collisions, broad ancestors, and aliases with fixture object IDs; dangerous host roots exist only in a fake filesystem.
2. Vary roots above and below synthetic sensitive directories and compare macOS policy and Linux mount intentions independently.
3. Use a single synthetic sibling read or exclusive marker for admitted deterministic native path cases; model renames, changing mounts, and races as scheduled fake-filesystem events.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Emit a fixture-ancestor PATH read grant, remove reverse-overlap rejection, or accept a stale directory identity in a mock plan.

**Safety/fidelity limit:** No live mount operations, FUSE, network filesystems, ancestor renames, TOCTOU races, or path probes outside the fixture. Runtime filename semantics remain platform-specific.

**Agent packet:** [S03 prompt](prompts/s03-path-scope.md).

## S04 — Synthetic secret confidentiality

**Vectors:** P04, P05, P06. **Findings:** F4. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** The documented sensitive-content boundary must cover every exposure route it claims, and no forbidden synthetic bytes may appear in child output.

**Implementation seams:** `native/shell-sandbox/src/lib.rs`, `native/shell-sandbox/tests/sandbox_e2e.rs`.

**Named tests to implement:** `SensitiveContentBoundary`, `SensitiveAliasContract`, `SnapshotChangeContract`, `MaskingIsNotDisclosure`.

**Adversarial cases:**

1. Place synthetic values in small conventional secret-name and generated-directory fixtures; vary suffix case and exempt-name assumptions without using real secret material.
2. Model or precreate a hard-link alias whose two names and inode are both owned by the fixture; try only the registered single read.
3. Simulate a file appearing after policy construction and require an explicit rejection, policy refresh, or recorded confidentiality limitation.
4. Distinguish macOS denial from Linux empty masking, with independent positive reads proving the probe works.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Remove one deny/mask or alias guard from a fake authority plan and check the canary oracle catches disclosure.

**Safety/fidelity limit:** No real credentials, home copies, Git secrets, concurrent tree mutation, or canary values in agent reports. Arbitrary content classification is not solved by filename tests.

**Agent packet:** [S04 prompt](prompts/s04-sensitive-content.md).

## S05 — Approval scope, persistence, and revocation

**Vectors:** A02, A03, A06, A09, A10, A12, A13, A14, O10. **Findings:** cross-cutting coverage. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** Approval must remain tied to its declared scope and explicit authority; failed persistence, changed membership, or revocation must not silently preserve broader grants.

**Implementation seams:** `src/shell/ShellCommandAuthorizer.ts`, `src/shell/FileShellPermissionStore.ts`, `src/project/context/ProjectContextResolver.ts`, `src/project/context/ProjectContextIdentity.ts`.

**Named tests to implement:** `ApprovalScopeContract`, `WorkspaceMembershipInvalidatesGrant`, `PolicySaveFailureIsAtomic`, `PermissionRevocationContract`, `NoEscalationAfterDenial`.

**Adversarial cases:**

1. Reuse the same inert command text under different directories, scripts, root sets, and background intent and inspect authorization decisions.
2. Change a fake workspace manifest while retaining its pathname and verify old grants are reauthorized or invalidated.
3. Inject save/load failures, invalid policy ownership, and revocation through fake stores; verify no permission widening or fallback.
4. Check multi-root display and persistent FULL_ACCESS decisions with fake presenters only.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Ignore root membership, retain a failed-save in-memory grant, or map a denial to FULL_ACCESS in fake authorization state.

**Safety/fidelity limit:** Never change real permissions, workspace manifests, persisted account state, or user policy files. No actual FULL_ACCESS command is launched.

**Agent packet:** [S05 prompt](prompts/s05-authorization.md).

## S06 — Terminal ownership and authority lifetime

**Vectors:** A07, A08, K16. **Findings:** F7. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** Terminal actions are owner-bound and carry explicit process authority; input and automatic wake cannot bypass that capability contract.

**Implementation seams:** `src/shell/ShellSessionManager.ts`, `src/shell/ShellToolRuntime.ts`, `src/terminal/TerminalApplication.ts`.

**Named tests to implement:** `TerminalCapabilityOwnership`, `InteractiveAuthorityLifetime`, `PendingAuthorizationOwnership`, `BackgroundLifecycleContract`.

**Adversarial cases:**

1. Create fake actors A and B and let B know A terminal ID; check list/read/input/close/reuse/wake authorization independently.
2. Feed inert stdin tokens to a fake interpreter process and ensure authority is recorded and checked for later input.
3. Schedule cancellation, immediate-child exit, timeout, and delayed descendant completion using fake process objects and clocks.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Remove one owner check or bypass the interactive authority check; model an early child-exit return that leaves cleanup incomplete.

**Safety/fidelity limit:** No actual interactive interpreter, FULL_ACCESS process, detached child, daemon, process-group manipulation, persistence, or termination evasion. Live descendant-escape claims remain unverified.

**Agent packet:** [S06 prompt](prompts/s06-terminal-capabilities.md).

## S07 — Trusted installation and trace writer

**Vectors:** P16, P18. **Findings:** F6, F8. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** Trusted launch/build inputs and trace destinations must not be controlled by writable projects; host writer identity must remain stable.

**Implementation seams:** `src/cli.ts`, `src/configuration/EnvironmentConfigurationProvider.ts`, `src/observability/FileLogger.ts`, `package.json`.

**Named tests to implement:** `TrustedConsumerSeparation`, `TraceDestinationAdmission`, `TraceWriterIdentity`.

**Adversarial cases:**

1. Build a synthetic installation/workspace graph and vary overlap of source, dependencies, executables, and build inputs.
2. Configure a fake trace inside, below, or aliased into a writable project; require rejection before logging.
3. Model replacement between checked destination and append/chmod as fake filesystem events and observe attempted authority, without performing deputy writes.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Accept a writable installation or trace destination, or reopen a replaced pathname in the mock writer.

**Safety/fidelity limit:** Never execute package scripts, rebuild poisoned helpers, launch Glyph from a modified checkout, activate IDE/watchers, redirect a real logger, or chmod a canary. Trusted-deputy exploitation is mock-only.

**Agent packet:** [S07 prompt](prompts/s07-trusted-consumers.md).

## S08 — Output, wake events, and presentation

**Vectors:** A01, A11, O01, O02, O03. **Findings:** F9. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** Untrusted output remains data/tool content and cannot acquire developer authority, change approval state, or leak fixture values into agent-facing reports.

**Implementation seams:** `src/shell/ShellSessionManager.ts`, `src/terminal/TerminalApplication.ts`, `src/providers/openai/OpenAIProvider.ts`, `src/terminal/ui/shared/sanitizeText.ts`.

**Named tests to implement:** `WakeOutputTrustBoundary`, `OutputProvenanceContract`, `ApprovalDisplayFidelity`, `ReportRedactionContract`.

**Adversarial cases:**

1. Send inert synthetic instruction-like text through a scripted wake path and inspect captured request roles locally.
2. Vary split terminal controls, bidi markers, confusables, and long-but-bounded display strings using snapshots, never an actual terminal control channel.
3. Place a fake sensitive token in mock output and assert the report emitter supplies only approved booleans and IDs.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Promote wake output to developer role, omit provenance, or forward raw mock output to the agent-report adapter.

**Safety/fidelity limit:** No real provider calls, no live prompt-injection success claim, no raw child output to agents, no OSC/terminal device actions. Disable wake/resume/tracing integration during native canaries.

**Agent packet:** [S08 prompt](prompts/s08-output-trust.md).

## S09 — Command grammar and policy serialization

**Vectors:** A04, A05, L05, P14. **Findings:** cross-cutting coverage. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** The safe classifier never stands in for containment; command data stays separate from backend options and policy syntax.

**Implementation seams:** `src/shell/isSafeShellCommand.ts`, `src/shell/NativeShellSandboxLauncher.ts`, `native/shell-sandbox/src/lib.rs`.

**Named tests to implement:** `SafeClassifierBoundary`, `CommandOptionSeparation`, `SeatbeltPathSerialization`, `ArchiveDestinationModel`.

**Adversarial cases:**

1. Generate at most 100 tiny inert quoting/option/whitespace examples and compare against an independently specified allowed grammar.
2. Place leading-option and escaped-path byte cases in recording launchers; verify separators and structured argument identity.
3. Model archive traversal against fixture path IDs without executing an extractor or interpreter.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Remove a separator, escape rule, or classifier rejection from a pure-data mutant; confirm the test catches the intended interpretation change.

**Safety/fidelity limit:** Never pass adversarial command text, expansions, utility execution options, serialized policy injection, or archives to a real shell/backend. Unmodeled dialect behavior is a residual gap.

**Agent packet:** [S09 prompt](prompts/s09-grammar-and-serialization.md).

## S10 — IPC, kernel surface, and loopback denial

**Vectors:** K01, K02, K03, K04, K05, K06, K07, K08, K09, K10, K11, K12, K13, K14, K15. **Findings:** F10. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** Every IPC/syscall/descriptor capability has an explicit bounded rationale; registered loopback cases demonstrate only the stated direct TCP restriction.

**Implementation seams:** `native/shell-sandbox/src/lib.rs`, `src/shell/NativeShellSandboxLauncher.ts`, `src/shell/SANDBOX_THREAT_MODEL.md`.

**Named tests to implement:** `IPCPolicyInventory`, `DescriptorInheritanceModel`, `NamespaceOptionsContract`, `FixtureLoopbackDenial`, `CVEApplicabilityRecord`.

**Adversarial cases:**

1. Audit the policy inventory for unexpected Mach services, shared memory, device/descriptor grants, namespace options, and exposed endpoint types using data models.
2. Model a host broker or inherited capability as an inert capability ID; ask whether the admission policy exposes it, without contacting anything.
3. For K14 only, propose one numeric fixture-loopback TCP connection with a controlled synthetic response and independent listener observations.
4. For CVEs, map affected component and prerequisites to supplied advisory/version records and explicitly separate unknown reachability.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Add an unreviewed capability to a mock policy or fake an unsupported backend as valid; never inject a kernel flaw or real service request.

**Safety/fidelity limit:** No Mach/XPC calls, shared-memory enumeration, host sockets, device ioctls, raw sockets, DNS, external traffic, CVE replay, privilege changes, namespaces/mount experiments, or exploit binaries. K14 native allowance does not extend to other K vectors.

**Agent packet:** [S10 prompt](prompts/s10-ipc-kernel-network.md).

## S11 — Bounded work, temporary storage, and metadata

**Vectors:** L07, P13, P17, O04, O05, O06, O07. **Findings:** cross-cutting coverage. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** Resource limits and lifecycle/report handling are explicit and independently supervised; fixture cleanup never follows attacker-controlled paths.

**Implementation seams:** `src/shell/ShellToolRuntime.ts`, `src/shell/ShellSessionManager.ts`, `native/shell-sandbox/src/lib.rs`.

**Named tests to implement:** `BoundedPreparationContract`, `InputBudgetContract`, `OutputBudgetContract`, `TemporaryStorageContract`, `CleanupOwnershipContract`.

**Adversarial cases:**

1. Use small injected limits and fake clocks to exercise boundary-minus-one/boundary/boundary-plus-one values without generating large loads.
2. Represent recursion, file size, process count, output volume, and backpressure as counters or fake streams.
3. Check temporary-storage admission and one approved scratch marker as a positive fixture case.
4. Represent metadata operations, devices, FIFOs, mounts, and side-channel observations as denied symbolic capabilities; do not exercise them on the host.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Remove a small input/scan bound, return success on timeout, or follow a fake cleanup symlink and require the appropriate safety assertion to fail.

**Safety/fidelity limit:** No exhaustion, load tests, fork loops, resource pressure, real metadata/ACL manipulation outside ordinary controller setup, timing side-channel measurements, or live cleanup evasion.

**Agent packet:** [S11 prompt](prompts/s11-bounds-and-fixtures.md).

## S12 — Harness, oracle, and evidence integrity

**Vectors:** O08, O09. **Findings:** cross-cutting coverage. Status: proposal reviewed; implementation evidence is tracked per vector in the coverage catalog.

**Required contract:** Only an independently observed restriction with valid controls and cleanup earns its declared evidence level; unrun/unsupported/static cells remain explicit.

**Implementation seams:** `native/shell-sandbox/tests/sandbox_e2e.rs`, `package.json`, `.github/workflows/ci.yml`, `src/shell/test/remediation/coverage.json`.

**Named tests to implement:** `CaseAdmissionContract`, `OperationSpecificOracle`, `CoverageCatalogCompleteness`, `PlatformEvidenceIsolation`, `MutationAttributionContract`.

**Adversarial cases:**

1. Give the fake harness nonzero setup errors, empty masked reads, forged marker strings, truncated reports, crashes, and missing positive controls.
2. Attempt to submit an unknown case, oversized proposal, foreign fixture slot, unsupported platform, or Astra worker identity; require rejection before execution.
3. Challenge coverage reports that conflate mocks with native enforcement, count CVEs as exploited, or close findings without regression evidence.

**Independent oracle:** use the per-vector acceptance statement in the catalog, not a snapshot copied from the current implementation. The initial code may fail these new contract tests; preserve the failure as a tracked finding rather than adjusting the assertion to present behavior.

**Safe negative controls:** Turn a skip into pass, accept a marker string without a file, or credit Linux evidence to macOS; require report validation to fail.

**Safety/fidelity limit:** Only fake failures and inert outcome records. Do not crash the real backend, kill unrelated processes, or execute a runtime campaign while auditing the plan.

**Agent packet:** [S12 prompt](prompts/s12-assurance-audit.md).

## Minimum regressions for the first remediation wave

| Finding | Positive control                                                             | Failure that must be detected                                                                         | Evidence limit                                                                                      |
| ------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| F1      | Valid trusted backend is selected in a recording launcher.                   | A writable PATH entry or invalid helper is accepted as a trusted origin.                              | No backend replacement execution.                                                                   |
| F2      | A legitimate approved metadata location keeps its intended write protection. | A Git pointer adds an unapproved read mount.                                                          | Mount-model/fixture evidence; no hostile native setup.                                              |
| F3      | Explicit trusted runtime/project read grant remains usable.                  | An arbitrary PATH ancestor or alias grants broader reads.                                             | Real macOS canary needed for macOS enforcement claim.                                               |
| F4      | An ordinary synthetic file is readable.                                      | A registered forbidden synthetic value appears through a covered alias/name/tree.                     | Empty Linux masking is valid; unspecified secret classification stays a residual contract question. |
| F5      | A normal fixture project is admitted.                                        | Either direction of sensitive-root overlap is admitted.                                               | Admission evidence is not generalized runtime proof.                                                |
| F6      | A trusted install outside writable roots is admitted.                        | A trusted launch/build chain depends on writable project content without a recorded trust transition. | Mock configuration only; no poisoned consumer launch.                                               |
| F7      | Actor A can use its correctly authorized fake session.                       | Actor B or unapproved stdin gains A session authority.                                                | Fake processes only.                                                                                |
| F8      | A stable trusted trace destination is admitted.                              | Workspace placement or replaced identity reaches modeled append/chmod.                                | No real deputy redirection or write-race case.                                                      |
| F9      | A trusted wake notification preserves untrusted output as data.              | Output enters developer-role instructions or changes the grant.                                       | Captured scripted request, no model judgment as oracle.                                             |
| F10     | An individually reviewed required permission is accepted.                    | Unreviewed service or blanket capability appears in the policy.                                       | Static/mocked inventory; broker correctness remains unverified.                                     |
