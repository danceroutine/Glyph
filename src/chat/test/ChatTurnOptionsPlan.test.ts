import { describe, expect, it } from 'vitest';
import { chatTurnOptionsSchema, planProgressSchema } from '#src/chat/ChatTurnOptionsSchema.ts';

describe('plan progress in turn options', () => {
  it.each([undefined, 'Implement selection'])('preserves valid progress with current task %s', current => {
    const progress = { planId: 'plan', title: 'Plan', completed: 1, total: 2, ...(current ? { current } : {}) };
    expect(chatTurnOptionsSchema.parse({ planProgress: progress })).toEqual({ planProgress: progress });
  });
  it('rejects impossible completed counts', () => {
    expect(planProgressSchema.safeParse({ planId: 'plan', title: 'Plan', completed: 3, total: 2 }).success).toBe(false);
  });
});
