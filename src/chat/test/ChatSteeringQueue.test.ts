import { describe, expect, it } from 'vitest';
import { ChatSteeringQueue } from '#src/chat/ChatSteeringQueue.js';

describe(ChatSteeringQueue, () => {
  describe(ChatSteeringQueue.prototype.add, () => {
    it('accepts each message once and drains its request at the next boundary', () => {
      const queue = new ChatSteeringQueue();
      const request = { text: 'Prefer tests.', attachments: [] };
      const message = {
        id: 'steer-1',
        text: 'Prefer tests.',
        createdAt: '2026-01-01T00:00:00.000Z',
        options: {},
        attachments: [],
      };

      queue.add(request, message);
      queue.add(request, message);

      expect(queue.messages).toEqual([message]);
      expect(queue.take(false)).toEqual([request]);
      expect(queue.take(false)).toEqual([]);
      expect(queue.messages).toEqual([message]);
    });

    it('rejects instructions after an empty final boundary', () => {
      const queue = new ChatSteeringQueue();

      expect(queue.take(true)).toEqual([]);
      expect(() => {
        queue.add(
          { text: 'Too late.', attachments: [] },
          { id: 'late', text: 'Too late.', createdAt: '2026-01-01T00:00:00.000Z', options: {}, attachments: [] },
        );
      }).toThrow('This response has finished. Send the instruction as a new message.');
    });

    it('keeps accepting instructions when the final boundary still had pending input', () => {
      const queue = new ChatSteeringQueue();
      const message = {
        id: 'first',
        text: 'First.',
        createdAt: '2026-01-01T00:00:00.000Z',
        options: {},
        attachments: [],
      };
      queue.add({ text: 'First.', attachments: [] }, message);

      expect(queue.take(true)).toEqual([{ text: 'First.', attachments: [] }]);
      queue.add(
        { text: 'Second.', attachments: [] },
        { id: 'second', text: 'Second.', createdAt: '2026-01-01T00:00:00.000Z', options: {}, attachments: [] },
      );
      expect(queue.messages.map(value => value.id)).toEqual(['first', 'second']);
    });
  });

  describe(ChatSteeringQueue.prototype.close, () => {
    it('stops accepting instructions', () => {
      const queue = new ChatSteeringQueue();
      queue.close();

      expect(() => {
        queue.add(
          { text: 'Closed.', attachments: [] },
          { id: 'closed', text: 'Closed.', createdAt: '2026-01-01T00:00:00.000Z', options: {}, attachments: [] },
        );
      }).toThrow('This response has finished.');
    });
  });
});
