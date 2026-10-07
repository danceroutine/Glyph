# Shell sandbox remediation campaign report

Campaign date: 2026-10-07. Source basis: commit `2b4e499` plus the campaign working-tree changes recorded in `coverage.json`. This report distinguishes source/unit evidence from native enforcement evidence.

## What ran

- The twelve proposal-only prompts ran independently on `gpt-5.6-luna` and `gpt-5.6-terra`: 24 bounded reviews total. The affected suites were reviewed again after remediation.
- Agents received the complete safety policy in every adversarial assignment. They performed source review and proposed inert unit/model cases only.
- No agent received a runtime controller, arbitrary shell, external endpoint, real secret, host service, or native exploit capability.
- The plan validator, focused TypeScript regressions, Rust unit tests, repository checks, and ordinary end-to-end suite ran locally. The ignored native torture test did not run.
- The final `gpt-5.6-sol` adjudication closed its trace-hard-link and evidence-ledger requirements with no remaining required changes; its disposition is `closed_with_residual_risks`.

## Remediations implemented

| Boundary                 | Change                                                                                                                                                                                                                               | Regression evidence                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Backend origin           | Linux Bubblewrap lookup uses fixed absolute candidates; environment overrides for native workers were removed.                                                                                                                       | Rust backend-candidate test; launcher recording tests.                       |
| Git mount authority      | Linux ignores repository-derived metadata targets outside declared workspace roots.                                                                                                                                                  | External `gitdir` mount-plan regression.                                     |
| macOS read grants        | Generated policy no longer turns inherited `PATH` entries into recursive reads.                                                                                                                                                      | Explicit readable-path unit inspection.                                      |
| Sensitive-root admission | Workspace roots overlapping known synthetic home-sensitive paths in either direction are rejected.                                                                                                                                   | Canonical overlap unit checks.                                               |
| Multi-root authority     | A shell launch receives only the most specific workspace root containing its working directory.                                                                                                                                      | Launcher argument regression.                                                |
| Protected-path authority | Linux overlays protected paths only when the path is already exposed by the selected workspace root.                                                                                                                                 | Mount-plan positive and negative checks.                                     |
| Self-hosting             | The package root and native workers are supplied as protected shell paths.                                                                                                                                                           | Launcher argument and native mount-policy checks.                            |
| Trace writer             | Trace/workspace overlap is rejected through existing-ancestor realpath identity; final trace entries are opened with `O_NOFOLLOW` and must be uniquely linked regular files before they are chmodded and written through one handle. | Direct/alias overlap plus final-component symlink and hard-link regressions. |
| Terminal capabilities    | List, reuse, input, and close operations require the owning chat context. Shell tools fail closed without it.                                                                                                                        | Two-actor manager and tool-runtime tests.                                    |
| Interactive authority    | Raw input to a `FULL_ACCESS` process is rejected; a complete new command must be authorized.                                                                                                                                         | Full-access input regression.                                                |
| Wake trust               | `shell_wake` content is serialized as user-role data instead of developer-role instructions.                                                                                                                                         | Scripted provider request regression.                                        |
| Approval scope           | Persistent exact-command grants bind command plus canonical working directory. Workspace membership binds the policy store to `mutationIdentity`.                                                                                    | Directory-scope, root-identity, and legacy migration checks.                 |
| Persistence atomicity    | The in-memory permission policy changes only after persistence succeeds.                                                                                                                                                             | Injected save-failure regression.                                            |
| Native setup bounds      | Workspace scans cap entries and depth; Git pointer reads cap bytes through a bounded file handle.                                                                                                                                    | Injected small-limit and oversized-pointer tests.                            |

## Ensemble disposition

| Suite                     | Luna                | Terra               | Current disposition                                                                                                                      |
| ------------------------- | ------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| S01 launcher trust        | contract unresolved | contract unresolved | Fixed search/override paths; executable ownership/content identity remains a contract decision.                                          |
| S02 Git metadata          | contract unresolved | contract unresolved | External Linux read-grant defect fixed; Git-history confidentiality remains undecided.                                                   |
| S03 path scope            | contract unresolved | proposed            | Concrete overlap and grant defects fixed; live alias/TOCTOU claims remain unverified.                                                    |
| S04 sensitive content     | contract unresolved | contract unresolved | Name/snapshot filtering remains defense in depth, not a complete confidentiality boundary.                                               |
| S05 authorization         | contract unresolved | contract unresolved | Directory, membership, and failed-save gaps fixed; broad-consent lifetime, revocation, and executable-revision binding remain undecided. |
| S06 terminal capabilities | contract unresolved | contract unresolved | Cross-chat control and full-access input gaps fixed; live descendant containment remains unverified.                                     |
| S07 trusted consumers     | contract unresolved | remaining findings  | Trace replacement fixed; package/executable provenance beyond protected fixed paths remains residual.                                    |
| S08 output trust          | contract unresolved | needs harness       | Wake role fixed; a complete output/report confidentiality contract remains unresolved.                                                   |
| S09 grammar               | proposed            | needs harness       | Pure model/property harness work remains; classifier results are not containment evidence.                                               |
| S10 IPC/kernel/network    | contract unresolved | contract unresolved | Static only; Mach/IPC decisions and exact deployed-CVE applicability remain unresolved.                                                  |
| S11 bounds                | contract unresolved | needs harness       | Setup bounds implemented; aggregate resource contracts and launch-observer harness work remain.                                          |
| S12 assurance             | contract unresolved | contract unresolved | Unit evidence accepted only at its stated lane; native cells remain `not_run`.                                                           |

## Evidence boundary

Passing unit and integration tests establish application behavior and intended native policy construction. They do not establish Seatbelt, Bubblewrap, kernel, Mach-service, or live-model resistance. `authority-contract.json` remains `draft_requires_review` with `execution_permission: none`; therefore no native canary or torture case was admitted, and no platform-native row may be marked passed.

The machine-readable ledger records the 24 proposal reviews, the Sol adjudication, remediation source references, named regression tests, and unit-cell results. Fixture/native cells without direct evidence remain `not_run`.

Run the safe implemented suite with:

```sh
pnpm shell-sandbox:remediation
```
