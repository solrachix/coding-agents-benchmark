import { BookList } from '@components/BookList';

export default function Home() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-4">Biblioteca</h1>
      <BookList />
    </main>
  );
}
