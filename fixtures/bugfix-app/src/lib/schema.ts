import { z } from "zod";

export const bookSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  author: z.string(),
  status: z.enum(["want_to_read", "reading", "finished"]),
  rating: z.number().min(1).max(5).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const importSchema = z.object({
  books: z.array(bookSchema),
});
