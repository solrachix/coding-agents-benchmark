# Event Atlas — Frontend Challenge reference

Crie uma interface de catálogo de eventos com aparência editorial e limpa.

## Layout

- Desktop (1440px): header horizontal com marca `Event Atlas`, busca ampla, avatar; sidebar esquerda de 240px; conteúdo principal com breadcrumb, título `Explore events`, subtítulo, chips de filtro, grid de três cards e painel lateral/section de upcoming events.
- Tablet (768px): sidebar vira uma barra superior compacta; grid tem duas colunas; chips continuam acessíveis sem cortar conteúdo.
- Mobile (390px): header reorganizado em duas linhas; sidebar desaparece; filtros podem rolar horizontalmente ou abrir drawer; cards ficam em uma coluna; nenhum conteúdo ultrapassa a viewport.

## Visual language

- fundo claro levemente azulado, cards brancos, bordas suaves e radius médio;
- cor primária azul-violeta, texto escuro com hierarquia forte;
- espaçamento generoso, títulos de card, local/data e preço/status claramente separados;
- imagens com proporção consistente, sem layout shift;
- estados de busca vazia e filtros ativos devem ser compreensíveis.

## Interactions

- busca filtra cards pelo título;
- chips filtram por categoria;
- menu de visualização alterna grid/lista;
- botão de cada card abre um modal de detalhes que fecha por botão e Escape;
- salvar evento altera seu estado visual;
- deve existir uma forma clara de voltar do estado vazio.

Os detalhes exatos de cores, tipografia e componentes são responsabilidade do agente, desde que a hierarquia, responsividade e intenção visual sejam preservadas.
