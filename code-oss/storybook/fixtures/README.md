# Storybook fixtures

This directory owns the sample data used by stories and the interactive workbench.
Import the fixture for the domain you need, then override only what distinguishes
that scenario. Keep story layout, event handlers, and host simulations in the story.

- `MessageFixtures.ts`: user, agent, and diagnostic entries, usage, and conversations.
- `MessageScenarios.ts`: named complete-message examples, including Markdown and code.
- `ToolFixtures.ts`: project calls, shell sessions, run projections, and progress.
- `InteractionFixtures.ts`: questions, approvals, and mode changes.
- `WorkspaceFixtures.ts`: attachments, navigation, plans, todos, and proposals.
- `AnnotationFixtures.ts`: captured comments.
- `ActionFixtures.ts`: preview callbacks and fresh composer controllers.
- `ViewFixtures.ts`: badge and review-control examples.

User and agent fixtures include timestamps and checkpoint IDs by default. Changing
an agent fixture's `id` also changes its checkpoint target. A user message points to
its assistant turn through `checkpointTurnId`. Static stories use a fixed timestamp;
interactive sends pass the time when the turn is created, once per turn. Missing
metadata should be an intentional scenario, not an omitted default.

Data factories copy their override data so examples can evolve independently.
Readonly catalogs define shared scenarios once. Mutable composer controllers must
be created per mounted preview. Composer/workbench args are seeds; the
`isolateComposer` decorator copies their document into a fresh controller. Interactive
previews own their controller with `useState(() => composerFixture())`.
