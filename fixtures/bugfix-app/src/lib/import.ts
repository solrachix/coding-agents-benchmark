import { importSchema } from "./schema";
import { prisma } from "./db";
import type { Book } from "./books";

export async function importBooksFromJson(jsonText: string): Promise<Book[]> {
  const parsed = JSON.parse(jsonText);
  const result = importSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Invalid import format");
  }
  const created: Book[] = [];
  for (const item of result.data.books) {
    try {
      const book = await prisma.book.create({
        data: {
          title: item.title,
          author: item.author,
          status: item.status,
          rating: item.rating,
        },
      });
      created.push(book);
    } catch {
      // intentionally empty in the broken fixture
    }
  }
  return created;
}
