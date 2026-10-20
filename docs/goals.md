# Durable goals

Type `/goal <objective>` in the composer to arm a durable goal for the chat. The
host stores the objective exactly as written, and a goal row above the composer
shows it with its status and time worked. While the goal is active and the chat is
idle, with no queued messages, pending decisions, or undelivered shell events,
the workbench asks the host for a continuation turn. Each turn carries the
objective as a user-role `goal_continuation` context event. The agent can propose
a goal with `goal.create_goal`, which arms nothing until you approve it, and
finishes one with `goal.update_goal`. Stopping a run or a failed run pauses the
goal, as do three continuations in a row without tool calls. Resuming is always
explicit: the row's Resume button, or the agent during a turn you started.
Goals are saved per chat in SQLite, survive reloads, and are not copied into
branches or restored from checkpoints.
