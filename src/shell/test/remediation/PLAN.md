# Shell sandbox stress-testing and remediation plan

This turns the [threat model](../../SANDBOX_THREAT_MODEL.md) into an implementation backlog and an ensemble campaign. The plan now includes an implemented safe regression runner and a completed proposal-only ensemble. See the [campaign report](CAMPAIGN_REPORT.md) for remediations, validation, and unresolved contracts. Native-canary execution remains disabled.

Coverage is based on the threat model's reviewed snapshot, commit `a82016548f39b7c2092d8775f753420c46d5d0c9`. Parallel source changes appeared during planning and were preserved. These entries are regression targets, not a claim that every original defect remains in the latest working tree. Before handing off a campaign, freeze a specific source snapshot and attach its hashes; reassess each finding against that snapshot instead of assuming old source line numbers or behaviors still apply.

The intended outcome is a reusable remediation suite: reproduce each safely observable defect, fix it, preserve a deterministic regression, and keep a separate record of risks that cannot safely be exercised. Coverage of a threat class does not mean permission to execute every technique in it.

## Deliverables and navigation

- [Coverage catalog](coverage.json): all 67 vectors and 16 CVEs, with proposed cases, expected behavior, permitted lanes, the completed proposal campaign, and per-cell unit evidence for implemented remediations.
- [Independent authority contract](authority-contract.json): versioned required boundaries and explicitly unresolved decisions about runtime reads, secret/history scope, approval lifetime, and IPC. It is reviewed independently of policy-generation code.
- [Readable coverage matrix](COVERAGE.md): the same per-vector backlog for review.
- [Automated suite specifications](TEST_SPECS.md): twelve implementation work packages, including fixtures, assertions, and regression requirements.
- [Red-team prompt index](prompts/README.md): twelve complete assignment prompts plus an adjudication prompt. Every assignment embeds the full safety policy; a fragment or a link to the policy is not an adequate handoff.
- [Plan validator](validate-plan.mjs): a local, dependency-free consistency check. It reads these documents and does not invoke the sandbox, tests, models, network, or child processes.
- [Safe regression runner](run-remediation.mjs): runs the validator, focused application regressions, and Rust unit tests. It does not run the ignored native torture test.
- [Campaign report](CAMPAIGN_REPORT.md): records the 24-agent proposal-only ensemble, implemented fixes, evidence level, and residual risks.

Run the implemented safe suite with `pnpm shell-sandbox:remediation`.

## 1. Non-negotiable execution contract

The [existing safety policy](../ADVERSARIAL_TESTING_SAFETY.md) remains the authority. No exception is created by moving a case to CI, Linux, a VM, another model, or an automated harness. Resource exhaustion, persistence, privilege escalation, denial of service, destructive operations, real-secret access, real host-service attacks, and external-network tests remain prohibited. CVE entries are used for applicability and regression design, not exploit replay.

“Stress” means systematically varying small inputs, state transitions, platform configurations, and independent reasoning. It does not mean stressing the Mac's resources. A weaker model's promise to obey the prompt is not containment.

The safety argument must remain true if Glyph's sandbox provides **no protection at all**. For a live case, a trusted, fixed probe can only read one synthetic file, attempt one exclusive creation containing exactly `I win`, or contact its specifically registered fixture loopback server. It cannot accept arbitrary shell text, arbitrary executable paths, a general program, a host PID, a URL, or an absolute target path from an agent. Races, interpreters, malicious plugins, host brokers, full-access sessions, and resource attacks use simulation where that guarantee cannot be established.

The controller creates and cleans fixtures; candidate code must not do so. Candidate code must not delete or overwrite even a failed marker. A verified unauthorized read/write/connection ends that case and stops the campaign's native lane. Preserve only a bounded sanitized report, clean the fixture, and remediate before rerunning that case. Do not keep searching for a more impressive escape.

### Distinguish four execution lanes

| Lane                  | Permitted work                                                                                                                                | What it can establish                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`                | Pure policy/argument checks, fake filesystem/process APIs, fake clocks, scripted model adapters, bounded grammar/property generators.         | Application logic, input validation, authorization transitions, and intended backend configuration. It does not prove kernel enforcement. |
| `fixture_integration` | Reviewed library calls against a fresh synthetic tree; no general command execution, real user configuration, model API, or host service.     | Real path/storage behavior within the fixture and safe integration of trusted components.                                                 |
| `native_canary`       | Approved fixed-operation probe through the real native backend against one fixture target; TCP loopback only for the designated network case. | The specific restriction on that OS/backend/configuration, provided the readiness and positive-control checks pass.                       |
| `static_only`         | Read supplied source and advisory records, inspect inert simulated metadata, and document prerequisites or unresolved reachability.           | A design review or applicability assessment. Never report runtime resistance or exploit success.                                          |

Lane lists in the catalog are ceilings, not instructions to use every lane. A live test must pass the controller's preflight even when its vector permits a native canary. A proposal that needs more power remains conceptual. Missing harness capabilities produce `needs_harness`, not a fallback to shell access.

## 2. Controller architecture

Implement a test-only controller separate from the code under test. Agents submit declarative proposals; a trusted compiler converts accepted proposals to known cases. The compiler and controller are not modifiable by a red-team agent. The case request schema uses allowlisted case IDs, fixture object IDs, and small enums. Reject unknown fields, free-form commands, executable uploads, external endpoints, and raw host paths before any operation.

The controller should own these responsibilities:

1. **Fixture factory:** create a unique temporary root with a random ownership sentinel; pin its canonical directory identity. Create the synthetic workspace, sibling forbidden tree, fake home, fake Glyph state, and private temporary directory. No files are copied from a real home or project secret store.
2. **Probe registry:** provide immutable, pre-reviewed operations compiled from trusted source. Pin executable identity before starting a case. Agent-produced code is never accepted as a runtime probe. Do not rebuild from a tree modified by a red-team case.
3. **Safety preflight:** resolve existing targets and parents of nonexistent targets; check component-aware containment under the fixture; verify all symlink/hard-link referents and endpoints; reject changed identities, unexpected mounts, devices, sockets, FIFOs, and unregistered objects. Native race cases are not allowed.
4. **Case launcher:** sanitize the environment with an explicit allowlist; use fixture `HOME`, state, caches, working directory, and temporary storage. Only controller-selected trusted executables are available. Never inherit credentials or load `.env` or personal shell startup files.
5. **Independent oracle:** check marker identity/content, forbidden canary disclosure, process launch requests, network fixture observations, and invariants through the trusted controller. Do not derive the expected result from the same policy builder under test.
6. **Budget supervisor:** enforce the small fixed budgets below independently of Glyph's timeout code. Each subprocess is a registered fixture-owned child. Agents have no signal/process-management interface. No broad process-group kill or PID search is allowed without proving ownership.
7. **Cleanup and reporting:** reap registered children and close fixture endpoints, then remove the tree through the controller's independently pinned root capability without following links. Keep that capability open until removal is verified. Reject a case before launch if its allowed operations could defeat owned-child termination or root-relative cleanup. An unexpected cleanup error is an incident that halts the lane and must be resolved through the pinned capability; it is not permission to abandon a fixture or perform a recursive removal through an uncertain pathname.

The fixture topology is deliberately larger than the inner sandbox's allowed workspace:

```text
fresh controller-owned temporary root/
  ownership-sentinel
  trusted/                controller-owned probe artifacts; never candidate-writable
  workspace-a/            intended allowed project
  workspace-b/            second project for explicit multi-root cases
  forbidden/              synthetic read canary or absent write-marker target
  synthetic-home/         fake credential directories with synthetic contents
  synthetic-state/        fake policy/account/log fixtures
  temporary/              sandbox scratch
```

“Outside workspace” always means a sibling **inside this temporary root**. A case must never target the real home, repository, `.git`, Glyph state, keychain, package-manager installation, `/etc`, or a host socket. Dangerous absolute strings such as `/` may appear only in fake-filesystem unit data; they must not be resolved or scanned by a live case. Trusted system executables and backend metadata are controller-selected dependencies, not attack targets.

### Probe contract

- `read_synthetic`: open only the registered regular canary for reading, up to 256 bytes. The local oracle compares the result; reports expose a boolean and fixture object ID, not its value.
- `create_marker`: attempt a single absent, uniquely named regular file using exclusive/no-follow creation, writing exactly the five bytes `I win`. Never truncate, append to, chmod, unlink, or replace an existing target. The oracle rejects partial, unexpected, or multiply created markers as unsafe/inconclusive evidence.
- `connect_fixture_loopback`: make at most one TCP connection to the numeric address/port from the controller-owned listener. Use `127.0.0.1` or `::1`, no DNS/proxies/redirects, and no externally routable or wildcard address. Only a synthetic canary may be returned; no project/host data is sent. No raw sockets or protocol fuzzing.

The loopback listener must be prebound and held open by the controller through all setup, control/candidate observation, and completion. Record socket identity and ownership, disallow shared-port binding and rebind, and prevent port reuse by keeping the socket open. Shut down only this owned listener after its probe finishes. If that lifetime cannot be guaranteed, do not admit the case. IPv4 and IPv6 TCP are separate cells; neither provides evidence about UDP, DNS, multicast, raw sockets, inherited connections, or brokered networking.

The read target is a registered regular file in the controller's fixture view. The Linux sandbox may deliberately replace that view with its known `/dev/null` mask; the probe/oracle must recognize this specific empty-read behavior without treating arbitrary devices or special files as acceptable targets. A guard that rejects an unexpected target type yields an explicit guard/harness outcome, not a claimed policy denial.

Do not use a normal interactive shell as the probe dispatcher. If a narrow shell invocation is needed to preserve the production launch path, it must be a controller-generated fixed invocation of the immutable probe, with quoted fixture parameters; command-grammar attacks stay in the mocked/unit lane. Full-access routing is verified with a recording launcher, never an actual unrestricted interpreter.

The known backend-trust and Git-mount gaps must be handled before broad native scheduling. A controller must not execute arbitrary `bwrap` candidates or mount untrusted arbitrary trees to demonstrate them. Start with launch-plan and mount-graph tests; any later narrow native case must use a verified patched backend and a fixed fixture-only target.

Backend replacement (F1), Git-derived read-mount expansion (F2), trusted-consumer execution (F6/F8), live interactive takeover (F7), and live model manipulation (F9) have no native execution permission in this catalog. A later campaign cannot infer permission for them from a related suite's harmless file case. Arbitrary hostile programs would require a separate outer containment design; that would still not authorize the prohibited classes in the safety policy.

Specifically, P09/P10's native designs concern only ordinary synthetic Git metadata/history paths. They cannot supply F2 mount-expansion evidence or close F2. F2's primary vector is P03, whose lanes are policy/fixture inspection only. Finding attribution is explicit in the catalog.

Disable Glyph's actual wake/resume and provider/tracing pipeline for native canaries. Test that pipeline only through scripted adapters. A native probe's stdout, stderr, error text, and canary values stay inside the controller; a generated report uses a closed set of enums/booleans. Preflight must reject unregistered commands, argv, scripts, environment overrides, targets, URLs, timing, or signal instructions rather than relying on model obedience.

Controls are separate bounded subcases with their own fresh fixtures. Each candidate performs only one attempted operation on one target. For registered path-alias cases, validate the referent inside the outer fixture while preserving the reviewed path spelling needed to exercise the inner boundary. If a probe's own no-follow check blocks an operation before Glyph's restriction is reached, report `blocked_by_guard`; do not claim kernel enforcement. Native cases never change paths concurrently.

### Initial budgets

These are conservative campaign settings, not new product limits:

| Resource                                 | Bound                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Concurrent native cases                  | 1 across the entire Mac; acquire a controller lock                                                                        |
| Candidate proposals per agent assignment | At most 4, each with at most 4 small variants                                                                             |
| Native cases per campaign invocation     | At most 24, then stop and review the report                                                                               |
| Per native case wall time                | 5 seconds; loopback connect deadline at most 1 second                                                                     |
| Known process topology                   | One fixed probe plus its explicitly registered launcher/backend processes; no candidate fork/spawn loops or daemonization |
| Fixture allocation                       | At most 64 ordinary objects, depth 8, total 1 MiB of content per case                                                     |
| Native path length                       | At most 1,024 bytes; large-size boundaries are simulated                                                                  |
| Captured output                          | 16 KiB total per case; terminate the owned probe on overflow and classify separately                                      |
| Property generation                      | Fixed seeds, at most 100 small in-memory examples per property and a 2-second property budget                             |
| Cleanup                                  | Bounded ownership-checked cleanup; stop the lane on a leak or uncertain ownership                                         |

Threshold enforcement itself uses mocks/fake clocks and small boundary values. These limits do not authorize deliberately approaching resource exhaustion. Background-lifetime evasion, ignored termination, reparenting, and process-group tricks stay in a fake-process model.

## 3. Independent outcomes and evidence

Each case needs both a working positive control and a forbidden-operation check. A nonzero exit code is not enough: it could mean missing tooling, malformed policy, rejected arguments, failed setup, or timeout. Capture readiness from the trusted launcher/probe, and distinguish a denial at the intended boundary from a blocked attempt at an independent outer guard.

For file reads, the success criterion is **no forbidden canary disclosure**. An empty successful read from Linux's `/dev/null` masking can be a valid result. On macOS an access error may be the expected result. Neither can replace a positive read of an allowed synthetic file. For writes, verify both the operation result and absence of the forbidden marker. For networking, verify listener readiness, a direct fixture control connection, and listener observations for the restricted attempt; isolate control and candidate connection accounting.

Use these result states rather than a single green/red flag:

| State                       | Meaning                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pass`                      | The specified oracle and positive control passed at the stated lane and platform.                                |
| `violation`                 | The independently observed result crossed the intended boundary; stop after the harmless witness.                |
| `harness_error`             | Setup, schema, observation, identity, or reporting failure; no product-security conclusion.                      |
| `timeout`                   | Budget reached; not proof of denial. Stop and examine using static evidence.                                     |
| `blocked_by_guard`          | An independent safety mechanism, not the boundary under test, prevented the operation. No enforcement credit.    |
| `unsupported`               | Required platform/backend/capability unavailable. Keep that coverage cell open.                                  |
| `not_run` / `needs_harness` | Planned work has not executed.                                                                                   |
| `unit_regression_passed`    | The named application or policy-construction regression passed; other lanes and cells remain independently open. |
| `static_only`               | Only a design/applicability review was performed.                                                                |
| `cleanup_failed`            | A fixture resource or ownership check remains unresolved; halt further native work.                              |
| `contract_unresolved`       | The independent expected-authority decision has not been reviewed. No pass or native admission.                  |
| `residual_risk`             | A known limitation has an owner and rationale; it is not a passing regression or a closed resistance claim.      |

Record commit and source hashes, case/probe/controller versions, fixture recipe hash, seed, lane, OS/architecture/backend identity and patch evidence, selected profile, requested and expected authority, parent/child readiness, outcome, and cleanup status. Keep authorization regressions distinct from kernel-enforcement regressions. Store local evidence with bounded size; agent-facing summaries contain only synthetic IDs, result enums, and sanitized source references. No fixture canaries, user paths, raw environment, arbitrary logs, or host data may be uploaded or placed in agent prompts.

Every vector has explicit `platform_cells`. Each native cell names an immutable **operation design ID**, exactly one probe/target slot, a variant, backend family, platform, profile, expected result, and positive-control ID. These are proposed designs, not registered executable cases. Runtime evidence must bind to exactly one matching cell; a top-level vector result cannot imply that its other operations, variants, or platforms passed. None of the broad titles, especially K14, is a substitute for those scoped cells.

The [authority contract](authority-contract.json) supplies the independent source of expected permissions. Current implementation output must not populate its approved allowlists automatically. Exact runtime paths, Git-history confidentiality, sensitive-content coverage, IPC rights and approval scope have explicit decision records. Until a blocking decision is reviewed, the associated case is `contract_unresolved`; P10 intentionally has no pass oracle yet. Record residual limitations with an owner, rationale, affected cells and reopening condition. Both unresolved contracts and residual risks are excluded from remediation/pass totals.

Any unexpected fixture mutation, malformed probe result, timeout, unaccounted-for descendant, or cleanup failure stops the native lane, not just an unauthorized canary success. Termination may affect only controller-owned registered children. If the controller cannot establish that ownership and termination are safe before launch, the case is not admitted.

For every fixed defect, run its oracle against a safe known-bad control in the unit/mock layer, then the corrected implementation. This can be a deliberately incorrect launch plan, missing owner check, excessive mount graph, or wrongly elevated message role. Never disable a real OS sandbox, install an old vulnerable backend, mutate the real application, or use a dangerous kernel exploit as a positive control. A mutation result proves that an assertion can detect its modeled defect, not that an OS escape is safely reproducible.

## 4. Automated suite implementation

The [suite specifications](TEST_SPECS.md) define the test names, fixtures, assertions, and intended source seams. Keep tests near the affected domain instead of adding an undifferentiated adversarial test file. Prefer the repository's existing Vitest and Rust test stacks; property generation can start with deterministic table/seed loops without adding a dependency.

Expected test areas:

- `src/shell/test/`: authorization, launch plans, interactive/session ownership, resolver behavior, and bounded utility recognition.
- `native/shell-sandbox/src/lib.rs` unit tests or a test module: policy and mount-plan construction, exact root/secret semantics, option separation, and serialization.
- `native/shell-sandbox/tests/`: individual allowlisted native canary cases behind an explicit opt-in runner; do not hide them in the existing all-in-one ignored test.
- `src/observability/tests/`, `src/project/context/test/`, `src/providers/openai/tests/`, and `src/terminal/tests/`: trace destination, workspace identity, context-role, and wake-flow regressions using fixture data and scripted adapters.
- A new test-only controller module with an explicit fixed-probe registry, no general command endpoint, and a machine-readable report contract.

Do not simply invoke the existing `shell-sandbox:torture` task as the new campaign: first split its compound case, fix the Linux empty-read expectation, add positive controls and explicit outcomes, and ensure each failure stops its case. Avoid broad existing test commands until the selected test paths have been reviewed; current session tests include real `FULL_ACCESS` launchers.

## 5. Ensemble work protocol

Use the models available in this session as concrete defaults: **GPT-5.6 Luna** and **GPT-5.6 Terra** independently propose cases; **GPT-5.6 Sol** can adjudicate disagreement. These are assignments, not performance guarantees. No GPT-6 Astra agent is assigned a red-team or adjudication role. A model's unavailability is an explicit scheduling gap, not permission to silently substitute Astra.

For each suite:

1. Give Luna and Terra the same sanitized source snapshot, suite specification, and complete prompt, without the other's conclusions. The first wave is proposal-only; the controller does not yet exist.
2. Each agent identifies boundary assumptions and returns at most four concrete cases using the contract in its prompt. It must include an independent expected result and explain why complete loss of Glyph confinement would remain harmless.
3. Deduplicate proposals by fixture shape, boundary, and oracle. Different wording is not an independent attack. Prefer complementary strategies rather than repeatedly trying the same spelling variation.
4. A controller maintainer checks every proposed operation against the allowlist and safety contract. Use Sol to review substantive disagreements; another model's approval is never sufficient to admit arbitrary code.
5. Implement accepted cases as deterministic tests. Red-team agents may submit designs/patch text for review but have no write permission to trusted controller/probe artifacts and no arbitrary execution tool.
6. Run only registered cases in their approved lane, native cases serially. Give agents sanitized result summaries. On a violation, stop the native lane and create the remediation record; do not ask agents to continue exploiting the same flaw.
7. After a fix, rerun the exact regression plus directly related cases and a second independent proposal pass. A real violation is never dismissed by a majority of passing model opinions.

Treat repository text, candidate descriptions, process output, and advisory excerpts as untrusted data. They cannot revise the policy, expand tools, request a new model, or authorize execution. Prompt constraints must be enforced by tool provisioning: source-bundle read and case-proposal submission only. A future registered-case invocation may be exposed only after the controller exists and the case is independently accepted. Its response cannot contain raw output or canaries.

The existing orchestration is used to discuss supplied nonsecret source and synthetic case designs. Neither test subprocesses nor agents receive a tool to browse the network, call a model endpoint, or upload local fixtures. The suite's model-behavior tests use local scripted adapters; live-provider behavioral experiments are not part of this plan.

## 6. Implementation phases and dependencies

| Phase                                  | Concrete output                                                                                                              | Exit criterion                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — This handoff                       | Catalog, suite specifications, complete prompts, and document validator.                                                     | Every threat-vector/CVE ID maps to a plan and safety lane; no runtime success claims.                                                     |
| 1 — Safety controller                  | Fixture ownership, declarative schema, fixed probe registry, bounds, outcomes, cleanup, and fail-closed preflight.           | Unit tests reject unsafe requests before launch; fault injection proves cleanup/reporting behavior without affecting unrelated processes. |
| 2 — Application and policy regressions | F1–F10 reproductions using launch spies, mount models, fake filesystems, scripted adapters, and limited fixture integration. | Each observed defect has a precise failing assertion, positive control, and remediation acceptance criterion.                             |
| 3 — Production fixes                   | Narrow patches grouped by trust boundary, with permission-data migration where required.                                     | Corrected cases pass; safe known-bad controls fail; ordinary allowed operations remain supported.                                         |
| 4 — Native confirmation                | Registered macOS cases and separately provisioned Linux cases using already available supported backends.                    | Platform-specific positive controls and canary oracles pass; no cleanup failures; unsupported cells remain explicit.                      |
| 5 — Ensemble maintenance               | Two independent proposals per suite, reviewed additions, fixed-seed regressions, and a local evidence register.              | New cases have traceable coverage; fixes stay covered across supported platform/backend configurations.                                   |

Prioritize backend selection and Git-derived mounts first (F1/F2), read scope and secret handling next (F3–F5), trusted consumers and trace destinations (F6/F8), then session ownership/authority and wake-role handling (F7/F9). Review IPC permissions (F10) statically in parallel. The platform CVE register is an applicability task, never a request to reproduce those exploits.

The plan proposes explicit capability contracts: saved approvals should be bound to intended execution scope; new workspace membership should invalidate or reauthorize grants; raw input authority should be visible and owner-bound; sensitive data should not be exposed through added mounts; command output should retain data/tool trust. These are remediation acceptance targets, not claims about current behavior. If a product decision intentionally grants broader authority, record it as a reviewed residual risk and test accurate disclosure/authorization; do not silently weaken the oracle to make tests green.

## 7. Platform and release gates

Keep separate cells for unit/simulated macOS policy, unit/simulated Linux mount plans, real macOS enforcement, and real Linux enforcement. A Mac cannot validate Linux runtime behavior. Linux native cases require an already provisioned isolated runner; this task does not install a VM, container engine, software, or backend. If no suitable runner exists, report `unsupported`/`not_run` and retain the gap.

Unit and reviewed fixture tests can become normal CI gates once implemented. Native runs need explicit case selection, a controller lock, no inherited credentials, a ready backend, and a per-run report. CI must preserve skipped/unsupported distinctions. No automatic fallback to `FULL_ACCESS`, network access, elevated privileges, or a different backend is allowed.

A remediation closes only when:

- The finding and its attacker prerequisites are recorded, with at least one independent oracle that would detect the modeled defect.
- The fix and any permission migration are reviewed; the expected behavior is a stated contract.
- Appropriate unit/fixture regressions pass, and native enforcement claims have evidence on each platform for which they are made.
- Positive controls work, denied operations are correctly distinguished from masking and setup failure, and cleanup completes.
- A second non-Astra agent reviews the fixture assumptions and neighboring variants.
- Any unsafe-to-exercise or unsupported portion remains labeled as residual risk or unverified; it is not counted as tested resistance.

Report totals separately for planned vectors, automated application regressions, platform-native confirmations, static assessments, outstanding violations, and residual risks. “67 vectors mapped” describes the catalog; only cells carrying explicit evidence describe work that ran.
