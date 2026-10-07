# Ready-to-hand red-team prompts

Every linked file is a complete proposal-only assignment with the full safety policy embedded. Do not hand over only a subsection. These files do not enable a runtime controller or authorize exploit execution. Read [PLAN.md](../PLAN.md) for lane limits and the ensemble sequence.

Assign each suite independently to GPT-5.6 Luna and GPT-5.6 Terra. Use [the adjudicator prompt](adjudicator.md) with GPT-5.6 Sol when substantive findings disagree. The model names are the available session roster, not a claim about benchmark capability or public API availability.

| Suite | Assignment                                                                   | Vectors                                                                   |
| ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| S01   | [Backend and executable origin](s01-launcher-trust.md)                       | L01, L02, L03, L04, L08, L09                                              |
| S02   | [Git metadata and mount authority](s02-git-metadata.md)                      | P03, P09, P10                                                             |
| S03   | [Path identity, roots, and read grants](s03-path-scope.md)                   | L06, P01, P02, P07, P08, P11, P12, P15                                    |
| S04   | [Synthetic secret confidentiality](s04-sensitive-content.md)                 | P04, P05, P06                                                             |
| S05   | [Approval scope, persistence, and revocation](s05-authorization.md)          | A02, A03, A06, A09, A10, A12, A13, A14, O10                               |
| S06   | [Terminal ownership and authority lifetime](s06-terminal-capabilities.md)    | A07, A08, K16                                                             |
| S07   | [Trusted installation and trace writer](s07-trusted-consumers.md)            | P16, P18                                                                  |
| S08   | [Output, wake events, and presentation](s08-output-trust.md)                 | A01, A11, O01, O02, O03                                                   |
| S09   | [Command grammar and policy serialization](s09-grammar-and-serialization.md) | A04, A05, L05, P14                                                        |
| S10   | [IPC, kernel surface, and loopback denial](s10-ipc-kernel-network.md)        | K01, K02, K03, K04, K05, K06, K07, K08, K09, K10, K11, K12, K13, K14, K15 |
| S11   | [Bounded work, temporary storage, and metadata](s11-bounds-and-fixtures.md)  | L07, P13, P17, O04, O05, O06, O07                                         |
| S12   | [Harness, oracle, and evidence integrity](s12-assurance-audit.md)            | O08, O09                                                                  |

## Handoff bundle

Include the complete prompt, its `coverage.json` rows/platform cells and `authority-contract.json`, its section of `TEST_SPECS.md`, and only the referenced nonsecret source snippets. State the assigned model explicitly. Start with no execution tools. Use the same source snapshot for independent reviewers and do not show their conclusions to each other before adjudication.

Suggested first wave: S01/S02 for launch and mount authority, S03/S04 for read confinement, S06/S07/S08 for application trust. S10 remains static except its separately registered K14 loopback case. S12 audits every result before it is counted.
