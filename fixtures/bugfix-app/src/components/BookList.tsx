import { Book } from "@/lib/books";

export function BookList() {
  const books: Book[] = [];
  return (
    <ul>
      {books.map((b) => (
        <li key={b.id}>{b.title}</li>
      ))}
    </ul>
  );
}
