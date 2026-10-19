# Declaration ordering

Oxlint loads Perfectionist and the local Storybook rule through `jsPlugins` in
`.oxlintrc.json`. Both run in the existing `pnpm lint` command; there is no separate
ESLint lint step.

Classes use `perfectionist/sort-classes` with this order:

1. Fields, arrow-function properties, index signatures, and static blocks.
2. Constructors.
3. Static methods/accessors: public, protected, then private.
4. Instance methods/accessors: public, protected, then private.

Members retain their authored order within each group. Fields share one group
across visibility levels so grouping does not rearrange their initialization
order. Implicit public members and JavaScript `#private` methods are included.

In `*.stories.{ts,tsx,js,jsx}`, `glyph-storybook/declaration-order` requires metadata
before its default export, followed by `StoryObj` type aliases and story exports.
Helpers can remain near their callers, and stories retain their authored order.
The rule recognizes named `StoryObj` imports, including import aliases, from
`@storybook/*` packages. Missing metadata/exports are outside this ordering rule.

The Storybook fixer moves type aliases and default exports of already-initialized
`const` metadata bindings. It preserves attached comments and leaves runtime
metadata initialization, mutable bindings, compact statements, and lint directives
for manual review.

Run `pnpm lint:fix`, then `pnpm lint`. Oxlint 1.86 applies a single fix pass and may
report overlapping diagnostics that the pass has already resolved. If ordering
errors remain, another fix pass can move declarations that depended on the first
move. Format edited files with Prettier afterward.

`pnpm exec vitest run scripts/lint/tests/ordering.test.mjs --maxWorkers=2` exercises
the configured rules through the actual Oxlint CLI. These tests also run with the
regular unit suite.
