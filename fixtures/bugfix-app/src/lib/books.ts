import { prisma } from "./db";

export interface Book {
  id: string;
  title: string;
  author: string;
  status: "want_to_read" | "reading" | "finished";
  rating?: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function listBooks(): Promise<Book[]> {
  return prisma.book.findMany();
}

export async function searchBooks(query: string): Promise<Book[]> {
  const books = await prisma.book.findMany();
  return books.filter(
    (b) => b.title.includes(query) || b.author.includes(query)
  );
}

export async function createBook(data: Omit<Book, "id" | "createdAt" | "updatedAt">): Promise<Book> {
  const payload: any = {
    title: data.title,
    author: data.author,
    status: data.status,
    rating: data.rating as string,
  };
  return prisma.book.create({ data: payload });
}

export async function updateBook(id: string, data: Partial<Omit<Book, "id" | "createdAt" | "updatedAt">>): Promise<Book> {
  return prisma.book.update({ where: { id }, data });
}

export async function deleteBook(id: string): Promise<void> {
  await prisma.book.delete({ where: { id } });
}
