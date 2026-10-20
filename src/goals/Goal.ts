import type { ChatGoal } from './ChatGoal.ts';
import { GoalError } from './GoalError.ts';
import { GoalPauseReason } from './GoalPauseReason.ts';
import { goalObjectiveSchema } from './GoalSchema.ts';
import { GoalStatus } from './GoalStatus.ts';

/**
 * A goal turns a single request into a standing objective, so the agent keeps
 * working across turns without the human prompting it again. The danger with this functionality is 
 * an agent that never stops burns tokens and makes unattended changes. Every rule about when a 
 * goal may keep running, stop, or be declared done lives here, so that the host, the agent's tools, 
 * and the human's controls all apply the same policy.
 *
 * Instances are immutable. The goal is persisted inside the chat record and
 * travels to the renderer as plain data, so the class only interprets a
 * `ChatGoal` and never becomes part of that data itself.
 */
export class Goal {
  /**
   * A model that has nothing left to do tends to reply with prose instead of
   * acting. Without this limit, a goal it can't finish (or won't admit is
   * finished) would wake it forever. Three idle continuations in a row is
   * approximately enough to tell "thinking between steps" apart from spinning in place.
   */
  static readonly MAX_IDLE_CONTINUATIONS = 3;

  /**
   * Private so every goal comes from either a fresh, validated objective or
   * a record that was already validated when it was stored. Callers can't
   * build a goal from arbitrary partial data.
   */
  private constructor(private readonly record: ChatGoal) {}

  /**
   * Arms a goal with the clock running from now. The objective is the
   * human's words, and continuation turns hand it back to the model verbatim
   * as untrusted data. Validating it here keeps empty or oversized objectives
   * out of storage and out of every later prompt.
   */
  static create(id: string, objective: string, now: Date): Goal {
    return new Goal({
      id,
      objective: goalObjectiveSchema.parse(objective),
      status: GoalStatus.ACTIVE,
      createdAt: now.toISOString(),
      continuationCount: 0,
      idleContinuationsWithoutToolCalls: 0,
      activeDurationMs: 0,
      activeSince: now.toISOString(),
    });
  }

  /**
   * Wraps a stored record without copying it. Storage relies on getting the
   * same object back to tell a no-op transition from a real one, so an
   * unchanged goal is never written again.
   */
  static from(record: ChatGoal): Goal {
    return new Goal(record);
  }

  /**
   * Requests from the renderer and the agent can wait behind other work. By
   * the time one runs, the human may have cleared the goal and armed a new
   * one. Comparing ids keeps a stale pause, resume, or continuation from
   * acting on the replacement.
   */
  get id(): string {
    return this.record.id;
  }

  /**
   * Run settlement only touches an active goal. A goal the human paused or
   * the agent completed mid-turn must keep that decision when the turn ends.
   */
  get status(): GoalStatus {
    return this.record.status;
  }

  /**
   * A chat holds one goal at a time, so no two objectives compete for the
   * same continuation turns. A paused goal still counts, because the human
   * may resume it. A completed goal has done its job and can be replaced
   * without clearing it first.
   */
  get isOpen(): boolean {
    return this.record.status === GoalStatus.ACTIVE || this.record.status === GoalStatus.PAUSED;
  }

  /**
   * Turns the goal back into the shape that SQLite and the desktop protocol
   * carry. When nothing changed, this is the very record the goal was built
   * from, which lets storage skip the write.
   */
  toChatGoal(): ChatGoal {
    return this.record;
  }

  /**
   * Time worked is what the human weighs when deciding whether to let a goal
   * keep running. It counts only active time, so time spent paused (waiting
   * on the human) doesn't make a goal look more expensive than it was. A
   * clock that moves backwards contributes nothing, rather than lowering the
   * total.
   */
  elapsedMs(now: Date): number {
    const { activeDurationMs, activeSince } = this.record;
    if (!activeSince) return activeDurationMs;
    return activeDurationMs + Math.max(0, now.getTime() - Date.parse(activeSince));
  }

  /**
   * Stops continuations without discarding the objective, so a stopped run,
   * a failure, or a stall can be looked at and resumed later. The reason is
   * kept because the human acts differently on "I stopped it", "it broke"
   * and "it had nothing left to do".
   */
  pause(reason: GoalPauseReason, now: Date): Goal {
    if (this.record.status !== GoalStatus.ACTIVE) throw new GoalError('Only an active goal can be paused.');
    return new Goal({ ...this.stopClock(now), status: GoalStatus.PAUSED, pauseReason: reason });
  }

  /**
   * Resuming is a fresh decision by the human. The idle streak starts over,
   * so a goal paused for stalling gets a full allowance again instead of
   * stalling straight back out.
   */
  resume(now: Date): Goal {
    if (this.record.status !== GoalStatus.PAUSED) throw new GoalError('Only a paused goal can be resumed.');
    const { pauseReason: _, ...rest } = this.record;
    return new Goal({
      ...rest,
      status: GoalStatus.ACTIVE,
      idleContinuationsWithoutToolCalls: 0,
      activeSince: now.toISOString(),
    });
  }

  /**
   * Completing a goal is the only way it ends on its own terms, and the
   * total time worked is kept for the human to see. A paused goal can also
   * be completed, for when the human tells the agent to stop for good. A
   * second completion is refused, because it means the agent lost track of
   * the goal's state.
   */
  complete(now: Date): Goal {
    if (this.record.status === GoalStatus.COMPLETE) throw new GoalError('This goal is already complete.');
    const { pauseReason: _, ...rest } = this.stopClock(now);
    return new Goal({ ...rest, status: GoalStatus.COMPLETE });
  }

  /**
   * Counts the continuation before the turn starts, so every automatic turn
   * is accounted for even if it is then cancelled or fails. Failing here,
   * rather than returning quietly, keeps a turn from starting for a goal
   * that was paused, completed, or replaced while the request waited.
   */
  beginContinuation(goalId: string): Goal {
    if (this.record.id !== goalId || this.record.status !== GoalStatus.ACTIVE)
      throw new GoalError('The goal changed before it could continue.');
    return new Goal({ ...this.record, continuationCount: this.record.continuationCount + 1 });
  }

  /**
   * Tool calls are the observable sign that a continuation did work. A turn
   * that only talked moves the goal toward the stall limit, and one that
   * acted resets it. If the goal changed during the turn, because the human
   * paused it or the agent completed it, that decision wins and the turn's
   * result is ignored.
   */
  recordContinuation(goalId: string, usedTools: boolean, now: Date): Goal {
    if (this.record.id !== goalId || this.record.status !== GoalStatus.ACTIVE) return this;
    if (usedTools)
      return this.record.idleContinuationsWithoutToolCalls === 0
        ? this
        : new Goal({ ...this.record, idleContinuationsWithoutToolCalls: 0 });
    const idle = new Goal({
      ...this.record,
      idleContinuationsWithoutToolCalls: this.record.idleContinuationsWithoutToolCalls + 1,
    });
    return idle.record.idleContinuationsWithoutToolCalls >= Goal.MAX_IDLE_CONTINUATIONS
      ? idle.pause(GoalPauseReason.STALLED, now)
      : idle;
  }

  /**
   * Folds the running span into the stored total whenever the goal stops
   * being active. Time worked then survives reloads and restarts, and a
   * dead process can't keep the clock running.
   */
  private stopClock(now: Date): ChatGoal {
    const { activeSince: _, ...rest } = this.record;
    return { ...rest, activeDurationMs: this.elapsedMs(now) };
  }
}
