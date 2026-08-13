Você deve criar um app completo em Next.js + TypeScript.

## Stack obrigatória

- Next.js App Router
- TypeScript
- Tailwind CSS
- Prisma
- SQLite
- Zod
- Vitest ou Jest
- ESLint

## Tema do app

Crie um pequeno sistema de biblioteca pessoal de livros.

## Requisitos funcionais

1. O usuário deve conseguir listar livros.
2. O usuário deve conseguir cadastrar um livro.
3. O usuário deve conseguir editar um livro.
4. O usuário deve conseguir deletar um livro.
5. O usuário deve conseguir buscar livros por título ou autor.
6. O usuário deve conseguir importar livros a partir de um arquivo JSON.
7. O JSON importado deve ser validado com Zod.
8. Cada livro deve ter:
   - id
   - title
   - author
   - status: "want_to_read" | "reading" | "finished"
   - rating opcional de 1 a 5
   - createdAt
   - updatedAt

## Requisitos técnicos

1. O projeto deve rodar com `npm install`.
2. O projeto deve passar em `npm run typecheck`.
3. O projeto deve passar em `npm test`.
4. O projeto deve passar em `npm run build`.
5. O projeto deve ter seed inicial para o banco.
6. O projeto deve ter README com instruções.
7. O projeto deve ter boa separação entre UI, validação, banco e regras de negócio.
8. Evite `any`.
9. Não use APIs inexistentes.
10. Não use dados mockados no lugar do banco real, exceto em testes.

## Testes obrigatórios

Crie testes para:

1. Validação de livro com Zod.
2. Importação de JSON válido.
3. Rejeição de JSON inválido.
4. Busca por título.
5. Busca por autor.

## Entrega esperada

Ao final, o projeto precisa estar completo no diretório atual.
Não explique demais. Implemente.

## Contrato mínimo para avaliação automatizada

Para permitir testes funcionais externos e iguais entre modelos, mantenha estes módulos/exportações:

- `src/lib/db.ts`: exporte `prisma` (instância de `PrismaClient`).
- `src/lib/schema.ts`: exporte `bookSchema` e `importSchema` usando Zod.
- `src/lib/books.ts`: exporte `listBooks`, `searchBooks`, `createBook`, `updateBook` e `deleteBook`.
- `src/lib/import.ts`: exporte `importBooksFromJson(jsonText: string)`.

`createBook` deve aceitar `{ title, author, status, rating? }`; `updateBook(id, data)` deve aceitar alterações parciais desses campos. `bookSchema` deve validar a forma persistida completa, com `id` UUID e `createdAt`/`updatedAt` como strings ISO-8601, compatíveis com JSON. `searchBooks` deve buscar por título **ou autor**, sem diferenciar maiúsculas/minúsculas. A importação recebe JSON no formato `{ "books": [...] }`, valida os livros com Zod e persiste no SQLite real.

O evaluator funcional é executado somente depois que o agente encerra e não deve ser substituído por testes do próprio projeto.

## Contrato mínimo de UI para E2E externo

O evaluator de UI é executado depois que o agente encerra. Preserve estes hooks de automação na interface real (não crie uma UI paralela ou mock apenas para o teste):

- lista/container dos livros: `data-testid="book-list"`
- cada livro renderizado: `data-testid="book-item"`, com atributos `data-status` e `data-rating` refletindo o valor persistido
- botão para iniciar cadastro: `data-testid="add-book"`
- título: `data-testid="title-input"`
- autor: `data-testid="author-input"`
- status: `data-testid="status-select"`, usando os values `want_to_read`, `reading`, `finished`
- rating: `data-testid="rating-input"`
- salvar cadastro/edição: `data-testid="save-book"`
- busca: `data-testid="search-input"`
- botão de editar dentro de cada item: `data-testid="edit-book"`
- botão de deletar dentro de cada item: `data-testid="delete-book"`
- input real `type="file"` para importar JSON: `data-testid="import-json-input"`
- se a importação exigir confirmação após selecionar o arquivo, use `data-testid="import-submit"` no botão; caso contrário, importe ao selecionar o arquivo.

Os hooks existem apenas para tornar a avaliação E2E determinística; os controles devem estar conectados aos mesmos fluxos reais usados pela interface e ao SQLite real.
