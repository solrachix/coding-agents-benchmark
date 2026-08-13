import { beforeEach, describe, it, expect, vi } from "vitest";
import { bookSchema } from "../src/lib/schema";
import { searchBooks, createBook } from "../src/lib/books";
import { importBooksFromJson } from "../src/lib/import";
import { prisma } from "../src/lib/db";

beforeEach(async () => {
  await prisma.book.deleteMany();
});

describe("bookSchema", () => {
  it("validates a correct book", () => {
    const book = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "Dune",
      author: "Frank Herbert",
      status: "reading" as const,
      rating: 5,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    expect(() => bookSchema.parse(book)).not.toThrow();
  });

  it("rejects invalid status", () => {
    const book = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "Dune",
      author: "Frank Herbert",
      status: "unknown",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
    expect(() => bookSchema.parse(book)).toThrow();
  });
});

describe("searchBooks", () => {
  it("is case-insensitive", async () => {
    await prisma.book.create({ data: { title: "Dune", author: "Frank Herbert", status: "reading" } });
    const books = await searchBooks("dune");
    expect(books.some((b) => b.title.toLowerCase() === "dune")).toBe(true);
  });
});

describe("createBook", () => {
  it("accepts optional rating", async () => {
    const book = await createBook({ title: "Test", author: "Author", status: "finished", rating: 3 });
    expect(book.title).toBe("Test");
  });
});

describe("importBooksFromJson", () => {
  it("imports valid json", async () => {
    const json = JSON.stringify({ books: [{
      id: "550e8400-e29b-41d4-a716-446655440001",
      title: "Neuromancer",
      author: "William Gibson",
      status: "finished",
      rating: 5,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }] });
    const result = await importBooksFromJson(json);
    expect(result.length).toBeGreaterThan(0);
  });

  it("rejects invalid json", async () => {
    const json = JSON.stringify({ books: [{
      id: "bad-id",
      title: "Neuromancer",
      author: "William Gibson",
      status: "finished",
      createdAt: "not-a-date",
      updatedAt: "not-a-date",
    }] });
    await expect(importBooksFromJson(json)).rejects.toThrow();
  });

  it("does not silently skip individual book errors", async () => {
    const spy = vi.spyOn(prisma.book, "create").mockRejectedValueOnce(new Error("DB error"));
    const json = JSON.stringify({ books: [{
      id: "550e8400-e29b-41d4-a716-446655440002",
      title: "DB Fail",
      author: "Author",
      status: "reading",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }] });
    await expect(importBooksFromJson(json)).rejects.toThrow();
    spy.mockRestore();
  });
});
