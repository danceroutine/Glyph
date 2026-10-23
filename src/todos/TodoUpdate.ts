import { z } from 'zod';
import { TodoStatus } from './TodoStatus.ts';

export const todoItemsSchema = z
  .array(
    z
      .object({
        id: z.string().trim().min(1).max(256),
        text: z.string().trim().min(1).max(1000),
        status: z.enum(TodoStatus),
      })
      .strict(),
  )
  .max(100)
  .superRefine((items, context) => {
    if (new Set(items.map(item => item.id)).size !== items.length)
      context.addIssue({ code: 'custom', message: 'Todo item IDs must be unique.' });
  });

export const todoUpdateSchema = z
  .object({
    items: todoItemsSchema,
    replace: z
      .boolean()
      .describe(
        'False updates items by stable ID, preserving omitted items and their order. True replaces the entire list; use an empty list to clear it.',
      ),
  })
  .strict();

export type TodoUpdate = z.infer<typeof todoUpdateSchema>;
